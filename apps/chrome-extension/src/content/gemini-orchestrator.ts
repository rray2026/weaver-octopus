// MutationObserver-driven orchestrator for Gemini.
//
// Why a separate orchestrator from src/content/orchestrator.ts:
// - Trigger source is different — Gemini has no API GET to intercept, so we
//   debounce on DOM mutations rather than on intercepted fetches.
// - Date filtering uses the myactivity prompt list (Gemini DOM has no
//   per-message timestamps), not Claude's per-message createdAt timestamps.
// - The user explicitly opted Gemini out of the popup's date filter — Gemini
//   always exports today.
//
// What it shares with the Claude path:
// - chrome.storage.local 'convHashes' (cross-tab SHA-256 dedup, prefixed with
//   "gemini:" so the keyspaces don't collide).
// - DOWNLOAD_REQUEST → background → chrome.downloads.download.
// - messagesToMarkdown / sanitizeFilename / hashString.

import { hashString } from './hash.js';
import { messagesToMarkdown, sanitizeFilename, todayDateString } from './markdown.js';
import {
  cleanTitle,
  computeTodaySlice,
  getConversationIdFromUrl,
  isLastTurnIncomplete,
  scrapeTurns,
  sliceFingerprint,
  type GeminiTurn,
} from './providers/gemini.js';
import type { ChatMessage, TodayGeminiPrompts } from '../types/index.js';

const HASH_STORAGE_KEY = 'convHashes';
const TODAY_STORAGE_KEY = 'todayGemini';
const TAG = '[weaver:gemini]';
const TRIGGER_DEBOUNCE_MS = 1500;
const REFRESH_WAIT_MS = 4000;

export interface GeminiOrchestratorOptions {
  /** Override timing in tests so we don't wait several seconds. */
  triggerDebounceMs?: number;
  refreshWaitMs?: number;
}

/** Wires up Gemini's content-script side: MutationObserver →
 *  scrape → today-slice → markdown → download. Returns a teardown function.
 */
export function startGeminiOrchestrator(
  options: GeminiOrchestratorOptions = {},
): () => void {
  const triggerDebounceMs = options.triggerDebounceMs ?? TRIGGER_DEBOUNCE_MS;
  const refreshWaitMs = options.refreshWaitMs ?? REFRESH_WAIT_MS;

  console.log(TAG, 'started', { origin: location.origin, href: location.href });
  let seq = 0;

  // Per-conversation, per-tab baseline. The first time the tab observes a
  // conversation, whatever turns are present are "history that this tab
  // didn't author". Anything beyond that index in this tab's lifetime is
  // "newSession" — guaranteed to be today, no myactivity match needed.
  const baselineByConv = new Map<string, number>();
  // In-tab "did we just send this exact slice" guard.
  let lastExportKey: string | null = null;
  // Cross-tab hash dedup, mirrored from chrome.storage.local 'convHashes'.
  const lastHashByConv = new Map<string, string>();
  // Single in-flight export — debounced trigger may overlap with a slow
  // download or activity refresh.
  let processing = false;
  let extensionInvalidated = false;
  let pendingTrigger: ReturnType<typeof setTimeout> | null = null;
  let lastUrl = location.href;

  const hydrationPromise = hydrateHashes();

  // ─── URL change detection ────────────────────────────────────────────────
  // Gemini is a SPA — pushState / replaceState navigations don't reload. We
  // wrap them so we can reset per-conversation state when the user opens a
  // different chat in the same tab.
  const detachHistoryHooks = installHistoryHooks(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    console.log(TAG, 'url change →', lastUrl);
    lastExportKey = null;
    schedule(triggerDebounceMs);
  });

  // ─── DOM observer ────────────────────────────────────────────────────────
  const root = document.body || document.documentElement;
  const mutationObs = new MutationObserver(() => schedule(triggerDebounceMs));
  mutationObs.observe(root, { childList: true, subtree: true });
  // First pass on load.
  schedule(triggerDebounceMs);

  // ─── Storage listener (cross-tab hash mirror) ────────────────────────────
  const storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (extensionInvalidated) return;
    if (area !== 'local' || !changes[HASH_STORAGE_KEY]) return;
    const next = changes[HASH_STORAGE_KEY].newValue as Record<string, string> | undefined;
    lastHashByConv.clear();
    if (next) for (const [k, v] of Object.entries(next)) lastHashByConv.set(k, v);
    console.log(TAG, 'convHashes mirrored', { count: lastHashByConv.size });
  };
  chrome.storage.onChanged.addListener(storageListener);

  return () => {
    mutationObs.disconnect();
    detachHistoryHooks();
    chrome.storage.onChanged.removeListener(storageListener);
    if (pendingTrigger) clearTimeout(pendingTrigger);
  };

  // ─── helpers ─────────────────────────────────────────────────────────────

  function schedule(delayMs: number): void {
    if (extensionInvalidated) return;
    if (pendingTrigger) clearTimeout(pendingTrigger);
    pendingTrigger = setTimeout(() => {
      pendingTrigger = null;
      void runExport().catch((err) => {
        if (isExtensionInvalidated(err)) markInvalidated();
        else console.error(TAG, 'runExport threw', err);
      });
    }, delayMs);
  }

  async function hydrateHashes(): Promise<void> {
    try {
      const items = await chrome.storage.local.get(HASH_STORAGE_KEY);
      const stored = items[HASH_STORAGE_KEY] as Record<string, string> | undefined;
      if (!stored) return;
      for (const [k, v] of Object.entries(stored)) lastHashByConv.set(k, v);
    } catch (err) {
      if (isExtensionInvalidated(err)) markInvalidated();
    }
  }

  async function runExport(): Promise<void> {
    if (processing || extensionInvalidated) return;
    processing = true;
    const id = ++seq;
    const tag = `${TAG}#${id}`;
    try {
      await hydrationPromise;
      if (extensionInvalidated) return;

      const turns = scrapeTurns(document);
      if (turns.length === 0) {
        console.log(tag, 'skip: no turns scraped');
        return;
      }
      const convId = getConversationIdFromUrl(location.href);
      if (!convId) {
        console.log(tag, 'skip: welcome page (no conversation id)');
        return;
      }
      if (isLastTurnIncomplete(turns, document)) {
        console.log(tag, 'skip: last turn still streaming');
        return;
      }

      // Establish baseline on first observation in this tab.
      if (!baselineByConv.has(convId)) baselineByConv.set(convId, turns.length);
      const baseline = baselineByConv.get(convId)!;
      const existing = turns.slice(0, baseline);
      const newSession = turns.slice(baseline);

      // Resolve which existing turns are "today" via the myactivity prompt
      // list. newSession is by definition this-tab-this-day, so it's always
      // included.
      let today = await readTodayPrompts();
      if (!today && newSession.length === 0) {
        await requestActivityRefresh(tag);
        await sleep(refreshWaitMs);
        today = await readTodayPrompts();
      }
      if (!today) {
        if (newSession.length === 0) {
          console.log(tag, 'skip: no myactivity data and no newSession');
          return;
        }
        // Still export newSession — it's guaranteed to be today.
        today = { date: todayDateString(), prompts: [] };
      }

      let existingToday = computeTodaySlice(existing, today.prompts);
      if (existingToday.length === 0 && newSession.length === 0) {
        // Neither newSession nor a today-match — try one more refresh in
        // case myactivity hadn't recorded the latest prompt yet.
        await requestActivityRefresh(tag);
        await sleep(refreshWaitMs);
        const refreshed = await readTodayPrompts();
        if (refreshed) {
          today = refreshed;
          existingToday = computeTodaySlice(existing, refreshed.prompts);
        }
      }

      const slice = [...existingToday, ...newSession];
      if (slice.length === 0) {
        console.log(tag, 'skip: nothing in today slice', {
          turns: turns.length,
          baseline,
          todayPrompts: today.prompts.length,
        });
        return;
      }

      const fingerprint = sliceFingerprint(slice);
      const inTabKey = `${convId}|${fingerprint}`;
      if (inTabKey === lastExportKey) {
        console.log(tag, 'skip: in-tab fingerprint unchanged');
        return;
      }
      lastExportKey = inTabKey;

      const title = cleanTitle(document.title) || `gemini-${convId.slice(0, 8)}`;
      const messages = turnsToMessages(slice);
      const markdown = messagesToMarkdown(
        messages,
        title,
        location.href,
        today.date,
        'gemini',
      );

      const newHash = await hashString(markdown);
      const hashKey = `gemini:${convId}`;
      const prevHash = lastHashByConv.get(hashKey);
      if (prevHash === newHash) {
        console.log(tag, 'skip: hash unchanged across tabs');
        return;
      }
      lastHashByConv.set(hashKey, newHash);
      try {
        await persistHashes();
      } catch (err) {
        if (isExtensionInvalidated(err)) {
          markInvalidated();
          return;
        }
        throw err;
      }

      const idSuffix = convId.slice(0, 8);
      const filename = `weaver-octopus/${todayDateString()}/[gemini] ${sanitizeFilename(title)}-${idSuffix}.md`;
      console.log(tag, 'sending DOWNLOAD_REQUEST', {
        filename,
        bytes: markdown.length,
        slice: slice.length,
      });
      try {
        const ack = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_REQUEST',
          filename,
          content: markdown,
        });
        if (!ack || !ack.ok) {
          console.error(tag, 'background rejected DOWNLOAD_REQUEST', ack);
          return;
        }
        console.log(tag, 'download acked', { downloadId: ack.downloadId });
      } catch (sendErr) {
        if (isExtensionInvalidated(sendErr)) {
          markInvalidated();
          return;
        }
        console.error(tag, 'sendMessage failed', sendErr);
      }
    } finally {
      processing = false;
    }
  }

  async function readTodayPrompts(): Promise<TodayGeminiPrompts | null> {
    try {
      const items = await chrome.storage.local.get(TODAY_STORAGE_KEY);
      const raw = items[TODAY_STORAGE_KEY] as TodayGeminiPrompts | undefined;
      if (!raw || !Array.isArray(raw.prompts)) return null;
      const today = todayDateString();
      // Stale entries from before today are useless.
      if (raw.date !== today) return null;
      return raw;
    } catch (err) {
      if (isExtensionInvalidated(err)) markInvalidated();
      return null;
    }
  }

  async function requestActivityRefresh(tag: string): Promise<void> {
    try {
      const ack = await chrome.runtime.sendMessage({ type: 'REFRESH_ACTIVITY' });
      console.log(tag, 'REFRESH_ACTIVITY ack', ack);
    } catch (err) {
      if (isExtensionInvalidated(err)) {
        markInvalidated();
        return;
      }
      console.warn(tag, 'REFRESH_ACTIVITY failed', err);
    }
  }

  async function persistHashes(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of lastHashByConv) obj[k] = v;
    await chrome.storage.local.set({ [HASH_STORAGE_KEY]: obj });
  }

  function markInvalidated(): void {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    console.warn(TAG, 'extension was reloaded — refresh this tab to resume');
  }
}

function turnsToMessages(turns: GeminiTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  for (const turn of turns) {
    if (turn.userText) {
      out.push({
        id: `gemini-u-${i}`,
        role: 'user',
        content: turn.userText,
        createdAt: 0,
      });
    }
    if (turn.modelText) {
      out.push({
        id: `gemini-a-${i}`,
        role: 'assistant',
        content: turn.modelText,
        createdAt: 0,
      });
    }
    i++;
  }
  return out;
}

function installHistoryHooks(onChange: () => void): () => void {
  const EVENT = 'weaver-gemini-locationchange';
  const fire = (): void => {
    window.dispatchEvent(new Event(EVENT));
  };
  type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;
  const orig: Record<'pushState' | 'replaceState', HistoryFn> = {
    pushState: history.pushState.bind(history),
    replaceState: history.replaceState.bind(history),
  };
  history.pushState = function patchedPush(...args: Parameters<HistoryFn>): void {
    orig.pushState(...args);
    fire();
  } as History['pushState'];
  history.replaceState = function patchedReplace(...args: Parameters<HistoryFn>): void {
    orig.replaceState(...args);
    fire();
  } as History['replaceState'];
  window.addEventListener('popstate', fire);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', fire);
    window.removeEventListener(EVENT, onChange);
    history.pushState = orig.pushState as History['pushState'];
    history.replaceState = orig.replaceState as History['replaceState'];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExtensionInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Extension context invalidated');
}
