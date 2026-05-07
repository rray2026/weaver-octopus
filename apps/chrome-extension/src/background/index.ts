import { startDevServer } from '@weaver-octopus/ext-dev-rpc/background';
import type {
  BackfillLogEntry,
  BackfillProgress,
  BackfillProviderProgress,
  BackfillProviderProgressPatch,
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  LastDownload,
  Provider,
} from '../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const BACKFILL_PROGRESS_KEY = 'backfillProgress';
const BACKFILL_STOP_FLAG = 'backfillStopRequested';
const TAG = '[weaver:bg]';
const MYACTIVITY_GEMINI_URL = 'https://myactivity.google.com/product/gemini';
const MYACTIVITY_QUERY_PATTERN = 'https://myactivity.google.com/product/gemini*';
// myactivity is heavyweight to load. Throttle reload requests so a hot
// stream of Gemini DOM mutations doesn't thrash the activity tab.
const MYACTIVITY_REFRESH_THROTTLE_MS = 30_000;
// chrome.storage.session is per-browser-session and survives SW restarts.
// We persist the myactivity tab id we created so a SW restart between two
// REFRESH_ACTIVITY calls doesn't open a duplicate (the in-memory
// lastActivityRefreshAt resets to 0 on restart, and chrome.tabs.query
// misses tabs that haven't yet committed their pendingUrl).
const MYACTIVITY_TAB_ID_KEY = 'myactivityTabId';
const BACKFILL_TAB_GROUP_TITLE = 'Weaver Octopus Backfill';
// chrome.tabGroups Color values — type alias is named differently across
// @types/chrome versions, so we keep this as a plain string the API accepts.
const BACKFILL_TAB_GROUP_COLOR = 'blue' as const;
const BACKFILL_DEFAULT_MIN_INTERVAL_MS = 1_000;
const BACKFILL_DEFAULT_MAX_INTERVAL_MS = 2_000;
const BACKFILL_DEFAULT_PER_CHAT_TIMEOUT_MS = 20_000;
// Sidebar is date-sorted past the pinned section, so once 5 consecutive
// chats fall outside the user's date range, the rest will too.
const BACKFILL_DEFAULT_STOP_AFTER_CONSECUTIVE_DATE_SKIPS = 5;
const BACKFILL_LOG_CAP_PER_PROVIDER = 200;
const PROVIDER_URLS: Record<Provider, string> = {
  claude: 'https://claude.ai/',
  gemini: 'https://gemini.google.com/app',
  chatgpt: 'https://chatgpt.com/',
};

let seq = 0;
let lastActivityRefreshAt = 0;

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', { reason: details.reason });
  // One-time storage cleanup. Removes:
  //  - claude-fetch-mode keys (abandoned: Claude's API still 403s when
  //    requests are replayed even with the full anthropic-* header set);
  //  - the legacy `todayGemini` key superseded by the multi-day
  //    `geminiActivity` index;
  //  - `liveCaptureEnabled` from the deleted popup toggle (the
  //    orchestrators now check `isBackfillInFlight()` only — there's no
  //    longer a "live capture" mode for the user to opt INTO).
  void chrome.storage.local
    .remove([
      'claudeApiHeaders',
      'claudeCaptureMode',
      'claudeOrgId',
      'todayGemini',
      'liveCaptureEnabled',
    ])
    .catch(() => undefined);
});

// Drop the tracked myactivity tab id the moment its tab closes — Chrome
// can recycle tab ids, so a stale value risks reloading the wrong tab.
chrome.tabs.onRemoved.addListener((closedTabId) => {
  void (async () => {
    const tracked = await getTrackedActivityTabId();
    if (tracked === closedTabId) {
      await setTrackedActivityTabId(null);
      console.log(TAG, 'cleared tracked myactivity tab on close', { tabId: closedTabId });
    }
  })();
});

// Dev-only: wire @weaver-octopus/ext-dev-rpc — forwarder + auto-reload +
// long-poll command queue. The whole call is dead-code-eliminated when
// __WEAVER_DEV__ is false.
// Shared command handlers used by both dev and production-rpc modes.
// All referenced identifiers (startBackfill, stopBackfill, …) are function
// declarations defined below — safe to reference here via closure.
function buildRpcHandlers(mode: string) {
  return {
    'start-backfill': async (cmd: Record<string, unknown>) => {
      const rawProviders = Array.isArray(cmd['providers'])
        ? (cmd['providers'] as unknown[])
        : ['claude', 'gemini'];
      const providers = rawProviders.filter(
        (p): p is Provider => p === 'claude' || p === 'gemini' || p === 'chatgpt',
      );
      return startBackfill(providers, mode, {
        intervalMinSec:
          typeof cmd['intervalMinSec'] === 'number' ? cmd['intervalMinSec'] : undefined,
        intervalMaxSec:
          typeof cmd['intervalMaxSec'] === 'number' ? cmd['intervalMaxSec'] : undefined,
      });
    },
    'stop-backfill': () => stopBackfill(mode),
    'reset-cache': () =>
      chrome.storage.local.remove([
        'convHashes',
        'lastDownload',
        'geminiActivity',
        'todayGemini', // legacy key — keep in the reset list for older installs
        BACKFILL_PROGRESS_KEY,
        BACKFILL_STOP_FLAG,
      ]),
    'open': (cmd: Record<string, unknown>) =>
      chrome.tabs.create({ url: String(cmd['url']), active: true }),
    // Set the popup's date-filter without opening the popup.
    // Mirrors the shape `popup/index.ts` writes.
    'set-filter': (cmd: Record<string, unknown>) => {
      const t = cmd['type'];
      if (t !== 'today' && t !== 'yesterday' && t !== 'last7days' && t !== 'thisWeek' && t !== 'range') {
        return { ok: false, error: `bad filter type: ${String(t)}` };
      }
      const filter: Record<string, unknown> = { type: t };
      if (t === 'range') {
        if (typeof cmd['start'] === 'string') filter['start'] = cmd['start'];
        if (typeof cmd['end'] === 'string') filter['end'] = cmd['end'];
      }
      return chrome.storage.local.set({ dateFilter: filter });
    },
    // Directly exercise refreshActivityTab. `force: true` bypasses the 30s
    // throttle — useful when iterating without waiting.
    'refresh-activity': async (cmd: Record<string, unknown>) => {
      if (cmd['force'] === true) __resetActivityThrottleForTests();
      return refreshActivityTab(mode);
    },
    // Ask the myactivity content script for a fresh scrape + diagnostics.
    'inspect-myactivity': async () => {
      const tabs = await chrome.tabs.query({
        url: 'https://myactivity.google.com/*',
      });
      if (tabs.length === 0) return { ok: false, error: 'no myactivity tab open' };
      const tab = tabs[0]!;
      if (tab.id == null) return { ok: false, error: 'myactivity tab has no id' };
      try {
        const ack = await chrome.tabs.sendMessage(tab.id, {
          type: 'INSPECT_MYACTIVITY',
        });
        return { ok: true, tabId: tab.id, tabUrl: tab.url, snapshot: ack };
      } catch (err) {
        return { ok: false, error: String(err), tabId: tab.id, tabUrl: tab.url };
      }
    },
    'dump-storage': async (cmd: Record<string, unknown>) => {
      const keys = Array.isArray(cmd['keys']) ? (cmd['keys'] as string[]) : null;
      return chrome.storage.local.get(keys);
    },
    'snapshot-dom': async (cmd: Record<string, unknown>) => {
      const target =
        cmd['target'] === 'claude' || cmd['target'] === 'gemini'
          ? (cmd['target'] as 'claude' | 'gemini')
          : undefined;
      const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      const geminiTabs = await chrome.tabs.query({
        url: 'https://gemini.google.com/*',
      });
      const candidates =
        target === 'claude'
          ? claudeTabs
          : target === 'gemini'
            ? geminiTabs
            : [...claudeTabs, ...geminiTabs];
      if (candidates.length === 0) return { ok: false, error: 'no matching tab open' };
      const tab = candidates.find((t) => t.active) ?? candidates[0]!;
      if (tab.id == null) return { ok: false, error: 'tab has no id' };
      try {
        const ack = await chrome.tabs.sendMessage(tab.id, { type: 'SNAPSHOT_DOM' });
        return {
          ok: true,
          tabId: tab.id,
          tabUrl: tab.url,
          snapshot: ack?.snapshot,
          ackError: ack?.error,
        };
      } catch (err) {
        return { ok: false, error: String(err), tabId: tab.id, tabUrl: tab.url };
      }
    },
    'diagnose': async () => {
      const manifest = chrome.runtime.getManifest();
      const storage = (await chrome.storage.local.get(null)) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(storage)) {
        if (key === 'convHashes' && value && typeof value === 'object') {
          const entries = Object.keys(value as Record<string, string>);
          summary[key] = { count: entries.length, sampleKeys: entries.slice(0, 3) };
        } else if (key === 'backfillProgress' && value && typeof value === 'object') {
          const prog = value as {
            state?: string;
            startedAt?: number;
            finishedAt?: number;
            errorMessage?: string;
            perProvider?: Record<
              string,
              {
                total?: number;
                done?: number;
                failed?: number;
                skipped?: number;
                log?: unknown[];
              }
            >;
          };
          const perProvider: Record<string, unknown> = {};
          for (const [p, pp] of Object.entries(prog.perProvider ?? {})) {
            perProvider[p] = {
              total: pp.total,
              done: pp.done,
              failed: pp.failed,
              skipped: pp.skipped,
              recentLog: Array.isArray(pp.log) ? pp.log.slice(-10) : [],
            };
          }
          summary[key] = {
            state: prog.state,
            startedAt: prog.startedAt,
            finishedAt: prog.finishedAt,
            errorMessage: prog.errorMessage,
            perProvider,
          };
        } else {
          summary[key] = value;
        }
      }
      const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      const geminiTabs = await chrome.tabs.query({
        url: 'https://gemini.google.com/*',
      });
      const chatgptTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      const myactivityTabs = await chrome.tabs.query({
        url: 'https://myactivity.google.com/*',
      });
      const tabs = [
        ...claudeTabs,
        ...geminiTabs,
        ...chatgptTabs,
        ...myactivityTabs,
      ].map((t) => ({
        id: t.id,
        url: t.url,
        status: t.status,
        active: t.active,
      }));
      return {
        extensionId: chrome.runtime.id,
        version: manifest.version,
        permissions: {
          permissions: manifest.permissions ?? [],
          hostPermissions: manifest.host_permissions ?? [],
        },
        tabs,
        storage: summary,
      };
    },
  };
}

// Dev-only: full dev-rpc sidecar — auto-reload, log forwarding, command poller.
// Dead-code-eliminated when __WEAVER_DEV__ is false.
if (__WEAVER_DEV__) {
  startDevServer({
    source: 'background',
    handlers: {
      ...buildRpcHandlers('[dev]'),
      'reload': () => chrome.runtime.reload(),
    },
  });
}

// Production RPC: command polling + log forwarding, no auto-reload.
// Enabled in builds produced by `pnpm build:rpc` (WEAVER_RPC=1).
// Dead-code-eliminated in plain production builds.
if (__WEAVER_RPC__) {
  // Clear the dev-build keepalive alarm so stale ticks don't wake this SW.
  void chrome.alarms.clear('ext-dev-rpc-keepalive');
  startDevServer({
    source: 'background',
    handlers: buildRpcHandlers('[rpc]'),
    features: { autoReload: false, forwarder: true, devLogRelay: false, commandPoller: true },
    tag: '[weaver:rpc]',
  });
}

type IncomingMessage =
  | ContentToBackgroundMessage
  | {
      type: 'START_BACKFILL';
      providers: Provider[];
      /** Optional override for per-chat random sleep window (seconds).
       *  Falls back to the BACKFILL_DEFAULT_*_INTERVAL_MS constants. */
      intervalMinSec?: number;
      intervalMaxSec?: number;
    }
  | { type: 'STOP_BACKFILL' };

chrome.runtime.onMessage.addListener((message: IncomingMessage, sender, sendResponse) => {
  // Dev-only `__DEV_LOG__` relay is handled by `startDevServer` above
  // (which registers its own onMessage listener). Production stays clean.
  // Chrome dispatches every onMessage to ALL registered listeners, so we
  // must fast-pass package-owned types here — otherwise every dev-log
  // tick triggers `unknown message type` noise + a useless `recv` log.
  const rawType = (message as { type?: unknown } | null | undefined)?.type;
  if (rawType === '__DEV_LOG__') return false;

  const id = ++seq;
  const tag = `${TAG}#${id}`;
  console.log(tag, 'recv', {
    type: message?.type,
    senderUrl: sender.tab?.url,
    senderTabId: sender.tab?.id,
  });

  // Popup-originated messages have no sender.tab — they come from the
  // extension's own context (default_popup). Allow those by checking for
  // matching URL prefix; otherwise enforce host_permissions on tabs.
  const fromPopup = !sender.tab && (sender.url?.startsWith(chrome.runtime.getURL('')) ?? false);
  if (!fromPopup && !isAllowedSender(sender.tab?.url)) {
    console.warn(tag, 'reject: sender not in host_permissions', {
      url: sender.tab?.url,
      sUrl: sender.url,
    });
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

  if (message.type === 'DOWNLOAD_REQUEST') {
    console.log(tag, 'DOWNLOAD_REQUEST', {
      filename: message.filename,
      bytes: message.content?.length,
    });
    triggerDownload(message.filename, message.content, tag)
      .then((downloadId) => {
        console.log(tag, 'ack ok', { downloadId });
        sendResponse({ ok: true, downloadId });
      })
      .catch((err) => {
        console.error(tag, 'triggerDownload failed', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === 'REFRESH_ACTIVITY') {
    refreshActivityTab(tag)
      .then((res) => {
        console.log(tag, 'REFRESH_ACTIVITY ack', res);
        sendResponse(res);
      })
      .catch((err) => {
        console.error(tag, 'refreshActivityTab failed', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === 'START_BACKFILL') {
    if (!fromPopup) {
      sendResponse({ ok: false, error: 'START_BACKFILL only allowed from popup' });
      return false;
    }
    startBackfill(
      message.providers,
      tag,
      {
        intervalMinSec: message.intervalMinSec,
        intervalMaxSec: message.intervalMaxSec,
      },
    )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'STOP_BACKFILL') {
    if (!fromPopup) {
      sendResponse({ ok: false, error: 'STOP_BACKFILL only allowed from popup' });
      return false;
    }
    stopBackfill(tag)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === 'BACKFILL_PROGRESS') {
    if (!sender.tab) {
      sendResponse({ ok: false, error: 'progress must come from a tab' });
      return false;
    }
    applyBackfillPatch(message.provider, message.patch, tag)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  console.warn(tag, 'unknown message type', message);
  sendResponse({ ok: false, error: 'unknown message type' });
  return false;
});

// Watch the lifecycle of every download we initiate so we can see whether the
// browser actually wrote the file or interrupted it (permissions, disk full,
// path invalid, conflict, etc.).
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    console.log(TAG, 'downloads.onChanged', {
      id: delta.id,
      state: delta.state.current,
      error: delta.error?.current,
    });
  }
  if (delta.error) {
    console.warn(TAG, 'download error', { id: delta.id, error: delta.error.current });
  }
});

// Trust any origin the manifest grants us host_permissions for. In production
// that's claude.ai, gemini.google.com, and myactivity.google.com (the latter
// only matters if we ever accept messages from that script — currently we don't).
function isAllowedSender(url: string | undefined): boolean {
  if (!url) return false;
  const patterns = chrome.runtime.getManifest().host_permissions ?? [];
  return patterns.some((p: string) => matchesHostPattern(url, p));
}

export function matchesHostPattern(url: string, pattern: string): boolean {
  // Minimal subset of MV3 match patterns: scheme://host/path. We only need
  // exact-host or wildcard-port matching for our tests.
  try {
    const m = pattern.match(/^([^:]+):\/\/([^/]+)(\/.*)?$/);
    if (!m) return false;
    const [, scheme, host] = m;
    const u = new URL(url);
    if (scheme !== '*' && u.protocol !== `${scheme}:`) return false;
    if (host === '*') return true;
    // host may contain ":*" to mean any port
    const [hostName, hostPort] = host!.split(':');
    if (hostName !== '*' && u.hostname !== hostName) return false;
    if (hostPort && hostPort !== '*' && u.port !== hostPort) return false;
    return true;
  } catch {
    return false;
  }
}

async function triggerDownload(filename: string, content: string, tag: string): Promise<number> {
  // Use a data: URL rather than a blob URL — blob URLs created in MV3 service
  // workers can fail silently in chrome.downloads.download on some Chrome
  // versions. Data URLs are universally supported.
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
  console.log(tag, 'chrome.downloads.download() invoke', {
    filename,
    urlBytes: url.length,
  });
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  console.log(tag, 'chrome.downloads.download() returned', { downloadId, filename });
  const last: LastDownload = { filename, at: Date.now() };
  await chrome.storage.local.set({ [LAST_DOWNLOAD_KEY]: last });
  console.log(tag, 'lastDownload persisted to storage.local');
  return downloadId;
}

interface RefreshActivityResult {
  ok: boolean;
  action?: 'created' | 'reloaded';
  reason?: string;
  tabId?: number;
}

async function refreshActivityTab(tag: string): Promise<RefreshActivityResult> {
  const now = Date.now();
  if (now - lastActivityRefreshAt < MYACTIVITY_REFRESH_THROTTLE_MS) {
    console.log(tag, 'refresh throttled', {
      sinceLast: now - lastActivityRefreshAt,
    });
    return { ok: false, reason: 'throttled' };
  }
  lastActivityRefreshAt = now;

  // 1) Trust a previously-tracked tab id first — it survives SW restarts
  //    via storage.session and dodges the `chrome.tabs.query` race where a
  //    just-created tab hasn't committed its URL yet.
  const tracked = await getTrackedActivityTabId();
  if (tracked != null) {
    const live = await tabExists(tracked);
    if (live) {
      await chrome.tabs.reload(tracked);
      console.log(tag, 'reloaded tracked myactivity tab', { tabId: tracked });
      return { ok: true, action: 'reloaded', tabId: tracked };
    }
    // Stale — drop and fall through.
    await setTrackedActivityTabId(null);
  }

  // 2) Fall back to a URL-based lookup for tabs the user opened manually
  //    (or that we created before the tracking code shipped).
  const tabs = await chrome.tabs.query({ url: MYACTIVITY_QUERY_PATTERN });
  if (tabs.length === 0) {
    // Open in the background — don't steal the user's focus from Gemini.
    const created = await chrome.tabs.create({ url: MYACTIVITY_GEMINI_URL, active: false });
    console.log(tag, 'created myactivity tab', { tabId: created.id });
    if (created.id != null) await setTrackedActivityTabId(created.id);
    return { ok: true, action: 'created', tabId: created.id };
  }

  // Self-heal: if we somehow ended up with multiple myactivity tabs (e.g.
  // an SW-restart race that pre-dated the tracking fix above), keep the
  // first one and close the rest. Cheap, idempotent, observable in logs.
  const target = tabs[0]!;
  if (tabs.length > 1) {
    const extras = tabs
      .slice(1)
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');
    if (extras.length > 0) {
      try {
        await chrome.tabs.remove(extras);
        console.log(tag, 'closed duplicate myactivity tabs', { closed: extras, kept: target.id });
      } catch (err) {
        console.warn(tag, 'failed to close duplicate myactivity tabs', err);
      }
    }
  }
  if (target.id != null) {
    await chrome.tabs.reload(target.id);
    await setTrackedActivityTabId(target.id);
  }
  console.log(tag, 'reloaded myactivity tab', { tabId: target.id });
  return { ok: true, action: 'reloaded', tabId: target.id };
}

async function getTrackedActivityTabId(): Promise<number | null> {
  try {
    const items = await chrome.storage.session.get(MYACTIVITY_TAB_ID_KEY);
    const v = items[MYACTIVITY_TAB_ID_KEY];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function setTrackedActivityTabId(id: number | null): Promise<void> {
  try {
    if (id == null) await chrome.storage.session.remove(MYACTIVITY_TAB_ID_KEY);
    else await chrome.storage.session.set({ [MYACTIVITY_TAB_ID_KEY]: id });
  } catch {
    // storage.session is unavailable in some test stubs — ignore.
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    return t != null;
  } catch {
    return false;
  }
}

/** Test-only: lets the test reset the in-memory throttle clock between cases. */
export function __resetActivityThrottleForTests(): void {
  lastActivityRefreshAt = 0;
}

// ─── Backfill coordinator ────────────────────────────────────────────────────

interface StartBackfillOverrides {
  intervalMinSec?: number;
  intervalMaxSec?: number;
}

async function startBackfill(
  providers: Provider[],
  tag: string,
  overrides: StartBackfillOverrides = {},
): Promise<{ ok: boolean; error?: string }> {
  if (providers.length === 0) return { ok: false, error: 'no providers selected' };

  const existing = await readProgress();
  if (existing.state === 'running') {
    return { ok: false, error: 'a backfill is already running' };
  }

  // Reset state.
  await chrome.storage.local.remove(BACKFILL_STOP_FLAG);
  const fresh: BackfillProgress = {
    state: 'running',
    startedAt: Date.now(),
    perProvider: Object.fromEntries(
      providers.map((p) => [p, makeEmptyProviderProgress() satisfies BackfillProviderProgress]),
    ) as BackfillProgress['perProvider'],
  };
  await writeProgress(fresh);

  const interval = resolveInterval(overrides);
  console.log(tag, 'backfill interval', interval);

  // Open / focus a tab per provider, all under one tab group.
  const tabIds: number[] = [];
  const providerTabs = new Map<Provider, number>();
  for (const p of providers) {
    try {
      const tabId = await ensureProviderTab(p);
      tabIds.push(tabId);
      providerTabs.set(p, tabId);
    } catch (err) {
      console.error(tag, 'ensureProviderTab failed', p, err);
      await patchProvider(p, {
        appendLog: [
          {
            at: Date.now(),
            provider: p,
            status: 'failed',
            reason: `failed to open tab: ${String(err)}`,
          },
        ],
      });
    }
  }

  if (tabIds.length === 0) {
    await mutateProgress((prog) => ({
      ...prog,
      state: 'error',
      finishedAt: Date.now(),
      errorMessage: 'no provider tabs could be opened',
    }));
    return { ok: false, error: 'no tabs opened' };
  }

  try {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: BACKFILL_TAB_GROUP_TITLE,
      color: BACKFILL_TAB_GROUP_COLOR,
      collapsed: false,
    });
    console.log(tag, 'tab group ready', { groupId, tabs: tabIds });
  } catch (err) {
    console.warn(tag, 'tab grouping failed (continuing)', err);
  }

  // Each tab runs independently. We dispatch in parallel; aggregate state is
  // tracked via BACKFILL_PROGRESS messages from each content script. When all
  // adapters report no currentTitle and the report queue drains, we mark done.
  const dispatches = Array.from(providerTabs.entries()).map(async ([provider, tabId]) => {
    // Wait for tab content script to be ready. Newly-created tabs may take
    // a few seconds to load and inject content.js.
    await waitForTabComplete(tabId, 30_000).catch(() => undefined);

    // Reused tabs may carry a stale content.js from before the extension was
    // updated. Ping first; reload+rewait if the listener is missing or
    // version-mismatched.
    const ready = await ensureContentScriptReady(tabId, tag, provider);
    if (!ready) {
      await patchProvider(provider, {
        appendLog: [
          {
            at: Date.now(),
            provider,
            status: 'failed',
            reason:
              'content script not responding (tab may need manual refresh, or the page is on a login/SSO redirect)',
          },
        ],
      });
      return;
    }

    const message: BackgroundToContentMessage = {
      type: 'BACKFILL_RUN',
      provider,
      minIntervalMs: interval.minMs,
      maxIntervalMs: interval.maxMs,
      perChatTimeoutMs: BACKFILL_DEFAULT_PER_CHAT_TIMEOUT_MS,
      stopAfterConsecutiveDateSkips: BACKFILL_DEFAULT_STOP_AFTER_CONSECUTIVE_DATE_SKIPS,
    };
    try {
      const ack = await chrome.tabs.sendMessage(tabId, message);
      console.log(tag, 'backfill provider done', { provider, ack });
    } catch (err) {
      console.error(tag, 'sendMessage to backfill tab failed', { provider, tabId, err });
      await patchProvider(provider, {
        appendLog: [
          {
            at: Date.now(),
            provider,
            status: 'failed',
            reason: `dispatch to tab failed: ${String(err)}`,
          },
        ],
      });
    }
  });

  // Don't await dispatches — return immediately so popup can render. Mark
  // done when all complete.
  Promise.allSettled(dispatches).then(async () => {
    await mutateProgress((prog) => ({
      ...prog,
      state: prog.state === 'stopping' ? 'idle' : 'done',
      finishedAt: Date.now(),
    }));
    await chrome.storage.local.remove(BACKFILL_STOP_FLAG);
    console.log(tag, 'all backfill dispatches finished');
  });

  return { ok: true };
}

async function stopBackfill(tag: string): Promise<{ ok: boolean }> {
  console.log(tag, 'stop requested');
  await chrome.storage.local.set({ [BACKFILL_STOP_FLAG]: true });
  await mutateProgress((prog) => ({ ...prog, state: 'stopping' }));
  // Best-effort: also send STOP messages so any tabs listening can short-circuit.
  // The runner already polls the storage flag, so this is belt-and-suspenders.
  for (const provider of ['claude', 'gemini'] as const) {
    try {
      const tabs = await chrome.tabs.query({ url: providerUrlPattern(provider) });
      for (const t of tabs) {
        if (t.id != null)
          chrome.tabs.sendMessage(t.id, { type: 'BACKFILL_STOP' }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

async function ensureProviderTab(provider: Provider): Promise<number> {
  const pattern = providerUrlPattern(provider);
  const tabs = await chrome.tabs.query({ url: pattern });
  // Multi-tab handling: when the user has several tabs of the same provider
  // open, pick deterministically and prefer the LEAST disruptive one to
  // hijack with sidebar clicks. Order:
  //   1. Tab on the provider's root / new-chat URL (no live conversation
  //      to interrupt). These are by definition idle.
  //   2. Active tab of the matching set.
  //   3. Lowest tab.id (oldest opened — stable across runs).
  // We don't want to pick a tab the user is mid-typing in if a quieter
  // candidate is available.
  const live = tabs.filter((t): t is chrome.tabs.Tab & { id: number } => t.id != null);
  if (live.length === 0) {
    const created = await chrome.tabs.create({ url: PROVIDER_URLS[provider], active: false });
    if (created.id == null) throw new Error('chrome.tabs.create returned no id');
    return created.id;
  }
  const rootUrls = providerRootUrls(provider);
  const onRoot = live.filter((t) => rootUrls.includes(t.url ?? ''));
  if (onRoot.length > 0) return pickStable(onRoot);
  const active = live.filter((t) => t.active);
  if (active.length > 0) return pickStable(active);
  return pickStable(live);
}

/** Stable pick: the lowest tab.id. Tab ids monotonically increase, so the
 *  oldest matching tab wins — repeat backfills hit the same tab unless
 *  it's closed. */
function pickStable(tabs: Array<{ id: number }>): number {
  return tabs.reduce((min, t) => (t.id < min ? t.id : min), tabs[0]!.id);
}

/** URLs we treat as "no live conversation to interrupt" — a backfill that
 *  drives sidebar clicks here is invisible to the user. */
function providerRootUrls(provider: Provider): string[] {
  if (provider === 'claude') return ['https://claude.ai/', 'https://claude.ai/new'];
  if (provider === 'gemini') return ['https://gemini.google.com/app'];
  return ['https://chatgpt.com/', 'https://chatgpt.com'];
}

function providerUrlPattern(provider: Provider): string {
  if (provider === 'claude') return 'https://claude.ai/*';
  if (provider === 'gemini') return 'https://gemini.google.com/*';
  return 'https://chatgpt.com/*';
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined);
    if (t?.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Verifies the freshest content.js (BACKFILL_PING handler, matching version)
 *  is loaded. If the ping fails or the tab carries a stale build, reload the
 *  tab and re-ping. Returns true on success, false if even the reloaded tab
 *  refuses to respond (e.g. a login/SSO redirect off the matched origin). */
async function ensureContentScriptReady(
  tabId: number,
  tag: string,
  provider: Provider,
): Promise<boolean> {
  const expectedVersion = chrome.runtime.getManifest().version;
  const expectedId = chrome.runtime.id;

  const ping = async (): Promise<{ matched: boolean; reason?: string }> => {
    try {
      console.log('[weaver:debug]', 'ping → tabs.sendMessage start', {
        tabId,
        provider,
        ts: Date.now(),
      });
      const ack = (await chrome.tabs.sendMessage(tabId, {
        type: 'BACKFILL_PING',
      } satisfies BackgroundToContentMessage)) as
        | { ok?: boolean; provider?: Provider; version?: string; extensionId?: string }
        | undefined;
      console.log('[weaver:debug]', 'ping → tabs.sendMessage returned', {
        tabId,
        provider,
        ack,
        ts: Date.now(),
      });
      if (!ack || !ack.ok) return { matched: false, reason: 'no ack' };
      if (ack.provider !== provider) {
        return { matched: false, reason: `provider mismatch (${ack.provider})` };
      }
      // Version is best-effort. If the content script's chrome.runtime is
      // invalidated, version may be undefined — treat that as stale.
      if (!ack.version) {
        return { matched: false, reason: 'stale runtime (version unknown)' };
      }
      if (ack.version !== expectedVersion) {
        return {
          matched: false,
          reason: `version mismatch (tab=${ack.version}, ext=${expectedVersion})`,
        };
      }
      if (ack.extensionId && ack.extensionId !== expectedId) {
        return { matched: false, reason: 'extension id mismatch' };
      }
      return { matched: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log('[weaver:debug]', 'ping → tabs.sendMessage threw', {
        tabId,
        provider,
        reason,
        ts: Date.now(),
      });
      return { matched: false, reason };
    }
  };

  const first = await ping();
  if (first.matched) {
    console.log(tag, 'content script ping ok', { tabId, provider, version: expectedVersion });
    return true;
  }
  console.log(tag, 'ping miss → reloading tab to inject fresh content.js', {
    tabId,
    provider,
    reason: first.reason,
  });
  try {
    await chrome.tabs.reload(tabId, { bypassCache: false });
  } catch (err) {
    console.warn(tag, 'tab reload failed', err);
    return false;
  }
  await waitForTabComplete(tabId, 30_000).catch(() => undefined);
  // content_scripts run at document_idle — give the listener a moment to register.
  await new Promise((r) => setTimeout(r, 1500));
  const second = await ping();
  if (!second.matched) {
    console.warn(tag, 'content script still unresponsive after reload', {
      tabId,
      provider,
      reason: second.reason,
    });
  }
  return second.matched;
}

/** Clamps the popup-supplied interval into the runner's accepted shape.
 *  Defaults to 1–2s — fast enough that small backfills feel instant and
 *  slow enough that click-driven captures usually settle before the next
 *  navigation. 0 is allowed (no pacing — risky for click-driven backfill
 *  but useful in tests).
 *
 *  Exported for unit tests. */
export function resolveInterval(overrides: StartBackfillOverrides): {
  minMs: number;
  maxMs: number;
} {
  const HARD_MIN_SEC = 0;
  const HARD_MAX_SEC = 600;
  const fallbackMinMs = BACKFILL_DEFAULT_MIN_INTERVAL_MS;
  const fallbackMaxMs = BACKFILL_DEFAULT_MAX_INTERVAL_MS;

  const clamp = (v: number | undefined, fallback: number): number => {
    if (v == null || !Number.isFinite(v)) return fallback;
    const sec = Math.max(HARD_MIN_SEC, Math.min(HARD_MAX_SEC, v));
    return Math.round(sec * 1000);
  };

  let minMs = clamp(overrides.intervalMinSec, fallbackMinMs);
  let maxMs = clamp(overrides.intervalMaxSec, fallbackMaxMs);
  if (maxMs < minMs) [minMs, maxMs] = [maxMs, minMs];
  return { minMs, maxMs };
}

function makeEmptyProviderProgress(): BackfillProviderProgress {
  return { total: 0, done: 0, failed: 0, skipped: 0, log: [] };
}

async function readProgress(): Promise<BackfillProgress> {
  const items = await chrome.storage.local.get(BACKFILL_PROGRESS_KEY);
  const raw = items[BACKFILL_PROGRESS_KEY] as BackfillProgress | undefined;
  return (
    raw ?? {
      state: 'idle',
      perProvider: {},
    }
  );
}

async function writeProgress(prog: BackfillProgress): Promise<void> {
  await chrome.storage.local.set({ [BACKFILL_PROGRESS_KEY]: prog });
}

// Serialise the read-modify-write sequence. Without this, two
// BACKFILL_PROGRESS messages arriving milliseconds apart both read
// the same stale snapshot, apply their patch, and the second write
// stomps the first. Symptom in real runs: provider `total` getting
// reset to 0 after the runner's initial `{total: N}` patch races
// with a near-simultaneous `{currentTitle: ...}` patch.
let mutateChain: Promise<unknown> = Promise.resolve();

async function mutateProgress(
  fn: (prev: BackfillProgress) => BackfillProgress,
): Promise<BackfillProgress> {
  const next = mutateChain.then(async () => {
    const prev = await readProgress();
    const out = fn(prev);
    await writeProgress(out);
    return out;
  });
  // Replace the chain with a tail that swallows errors so one rejection
  // doesn't poison every subsequent mutateProgress call.
  mutateChain = next.catch(() => undefined);
  return next;
}

async function applyBackfillPatch(
  provider: Provider,
  patch: BackfillProviderProgressPatch,
  tag: string,
): Promise<void> {
  console.log(tag, 'BACKFILL_PROGRESS', { provider, patch });
  await patchProvider(provider, patch);
}

async function patchProvider(
  provider: Provider,
  patch: BackfillProviderProgressPatch,
): Promise<void> {
  await mutateProgress((prog) => {
    const cur = prog.perProvider[provider] ?? makeEmptyProviderProgress();
    const merged: BackfillProviderProgress = {
      ...cur,
      total: patch.total ?? cur.total,
      // INCREMENT semantics match `failed`/`skipped` — runner now sends
      // `{done: 1}` per success rather than the (loop-index-driven)
      // absolute count.
      done: cur.done + (patch.done ?? 0),
      failed: cur.failed + (patch.failed ?? 0),
      skipped: cur.skipped + (patch.skipped ?? 0),
      currentTitle:
        patch.currentTitle === undefined
          ? cur.currentTitle
          : patch.currentTitle === null
            ? undefined
            : patch.currentTitle,
      log: appendLog(cur.log, patch.appendLog),
    };
    return {
      ...prog,
      perProvider: { ...prog.perProvider, [provider]: merged },
    };
  });
}

function appendLog(
  prev: BackfillLogEntry[],
  toAppend: BackfillLogEntry[] | undefined,
): BackfillLogEntry[] {
  if (!toAppend || toAppend.length === 0) return prev;
  const out = [...prev, ...toAppend];
  if (out.length <= BACKFILL_LOG_CAP_PER_PROVIDER) return out;
  return out.slice(out.length - BACKFILL_LOG_CAP_PER_PROVIDER);
}

/** Test-only export so unit tests can inspect the merger logic without
 *  going through chrome.storage. */
export const __backfillInternals = {
  appendLog,
  makeEmptyProviderProgress,
  patchProvider,
  writeProgress,
  readProgress,
  ensureProviderTab,
};
