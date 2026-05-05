import { devOnInstalled, startDevAutoReload } from './dev-autoreload.js';
import type {
  BackfillLogEntry,
  BackfillProgress,
  BackfillProviderProgress,
  BackfillProviderProgressPatch,
  BackgroundToContentMessage,
  ClaudeCaptureMode,
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
const BACKFILL_TAB_GROUP_TITLE = 'Weaver Octopus Backfill';
// chrome.tabGroups Color values — type alias is named differently across
// @types/chrome versions, so we keep this as a plain string the API accepts.
const BACKFILL_TAB_GROUP_COLOR = 'blue' as const;
const BACKFILL_DEFAULT_MIN_INTERVAL_MS = 4_000;
const BACKFILL_DEFAULT_MAX_INTERVAL_MS = 6_000;
const BACKFILL_DEFAULT_PER_CHAT_TIMEOUT_MS = 20_000;
// Sidebar is date-sorted past the pinned section, so once 5 consecutive
// chats fall outside the user's date range, the rest will too.
const BACKFILL_DEFAULT_STOP_AFTER_CONSECUTIVE_DATE_SKIPS = 5;
const BACKFILL_LOG_CAP_PER_PROVIDER = 200;
const PROVIDER_URLS: Record<Provider, string> = {
  claude: 'https://claude.ai/',
  gemini: 'https://gemini.google.com/app',
};

let seq = 0;
let lastActivityRefreshAt = 0;

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', { reason: details.reason });
  // Dev-only: refresh matched tabs after a self-reload triggered by the
  // file-watcher poller below. Tree-shaken in production.
  if (__WEAVER_DEV__) void devOnInstalled(details);
});

// Dev-only: poll dist/build_id.txt and chrome.runtime.reload() on change
// so each `WEAVER_DEV=1 pnpm dev` rebuild lands automatically. The const
// gate ensures the import + call are dropped from production bundles.
if (__WEAVER_DEV__) startDevAutoReload();

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

  const tabs = await chrome.tabs.query({ url: MYACTIVITY_QUERY_PATTERN });
  if (tabs.length === 0) {
    // Open in the background — don't steal the user's focus from Gemini.
    const created = await chrome.tabs.create({ url: MYACTIVITY_GEMINI_URL, active: false });
    console.log(tag, 'created myactivity tab', { tabId: created.id });
    return { ok: true, action: 'created', tabId: created.id };
  }
  const target = tabs[0]!;
  if (target.id != null) await chrome.tabs.reload(target.id);
  console.log(tag, 'reloaded myactivity tab', { tabId: target.id });
  return { ok: true, action: 'reloaded', tabId: target.id };
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

  // Read the user's Claude capture-mode preference once. It controls both
  // live capture (set by the content script at page load) and backfill —
  // here we use it to pick the BACKFILL_RUN mode. Gemini is always click-
  // based (no clean conversation API to call directly).
  const claudeMode = await readClaudeCaptureMode();
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
      mode: provider === 'claude' && claudeMode === 'fetch' ? 'fetch' : 'click',
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
  // Prefer an existing tab so we don't duplicate browsing context. If the
  // user is mid-conversation we won't disturb them — but we'll still navigate
  // them through history during the backfill (acceptable: that's the feature).
  if (tabs.length > 0 && tabs[0]!.id != null) return tabs[0]!.id;
  const created = await chrome.tabs.create({ url: PROVIDER_URLS[provider], active: false });
  if (created.id == null) throw new Error('chrome.tabs.create returned no id');
  return created.id;
}

function providerUrlPattern(provider: Provider): string {
  return provider === 'claude' ? 'https://claude.ai/*' : 'https://gemini.google.com/*';
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
      const ack = (await chrome.tabs.sendMessage(tabId, {
        type: 'BACKFILL_PING',
      } satisfies BackgroundToContentMessage)) as
        | { ok?: boolean; provider?: Provider; version?: string; extensionId?: string }
        | undefined;
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
 *  Defaults preserve the previous behaviour (4–6s). 0 is allowed (no
 *  pacing, useful for fetch-mode where each request is cheap).
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

async function readClaudeCaptureMode(): Promise<ClaudeCaptureMode> {
  try {
    const items = await chrome.storage.local.get('claudeCaptureMode');
    const v = items['claudeCaptureMode'];
    return v === 'fetch' ? 'fetch' : 'intercept';
  } catch {
    return 'intercept';
  }
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

async function mutateProgress(
  fn: (prev: BackfillProgress) => BackfillProgress,
): Promise<BackfillProgress> {
  const prev = await readProgress();
  const next = fn(prev);
  await writeProgress(next);
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
      done: patch.done ?? cur.done,
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
};
