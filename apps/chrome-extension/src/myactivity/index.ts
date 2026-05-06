// Content script for myactivity.google.com/product/gemini.
// Scrapes the multi-day prompt index out of the rendered DOM, debounced
// on MutationObserver events, and persists to chrome.storage.local under
// the `geminiActivity` key. The Gemini content script reads that key and
// flattens the days falling in the user's date filter range.

import { collectActivityByDate } from './scraper.js';
import type { GeminiActivityIndex } from '../types/index.js';

const STORAGE_KEY = 'geminiActivity';
const TAG = '[weaver:myactivity]';

// Dev-only console forwarder. Inlined (instead of imported from
// `@weaver-octopus/ext-dev-rpc/content`) because the package import
// produces a chunk that — for reasons we haven't fully chased — does
// not resolve correctly when the content script runs on
// myactivity.google.com (the same import works in content.js on
// claude.ai / gemini.google.com). Inlining sidesteps the chunk and
// keeps the file standalone. Whole forwarder is ~25 lines; the
// duplication is cheaper than diagnosing the chunk-load asymmetry.
if (__WEAVER_DEV__) startInlineDevForwarder('myactivity');

function startInlineDevForwarder(source: string): void {
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        chrome.runtime
          .sendMessage({
            type: '__DEV_LOG__',
            payload: JSON.stringify({
              source,
              level,
              args: args.map((v) => {
                if (v instanceof Error)
                  return { __type: 'Error', name: v.name, message: v.message, stack: v.stack };
                try {
                  JSON.stringify(v);
                  return v;
                } catch {
                  return String(v);
                }
              }),
              ts: Date.now(),
            }),
          })
          .catch(() => undefined);
      } catch {
        /* extension context invalidated */
      }
    };
  }
}
const INITIAL_DELAY_MS = 1500;
const DEBOUNCE_MS = 1200;

let lastPayload = '';
let pending: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  let index: GeminiActivityIndex;
  try {
    index = collectActivityByDate(document, new Date());
  } catch (err) {
    console.warn(TAG, 'collectActivityByDate threw', err);
    return;
  }
  // Compare on `days` only — `scrapedAt` ticks every flush by definition,
  // and we don't want a no-op write per debounce cycle.
  const fingerprint = JSON.stringify(index.days);
  if (fingerprint === lastPayload) return;
  lastPayload = fingerprint;
  console.log(TAG, 'activity index', {
    days: index.days.length,
    totalPrompts: index.days.reduce((n, d) => n + d.prompts.length, 0),
  });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: index });
  } catch (err) {
    // The extension can be reloaded mid-session; subsequent storage calls
    // throw "Extension context invalidated" until the tab is refreshed.
    console.warn(TAG, 'storage.local.set failed (context may be invalid)', err);
  }
}

function schedule(delayMs: number): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void flush();
  }, delayMs);
}

console.log(TAG, 'starting');
schedule(INITIAL_DELAY_MS);
const observer = new MutationObserver(() => schedule(DEBOUNCE_MS));
observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
});

// Dev-only: dump everything we'd need to debug the scraper. Returns the
// fresh scrape result PLUS a coarse summary of what date-headers look
// like in the current DOM, so we can tell at a glance whether the
// document has finished hydrating.
if (__WEAVER_DEV__) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (
      !msg ||
      typeof msg !== 'object' ||
      (msg as { type?: unknown }).type !== 'INSPECT_MYACTIVITY'
    ) {
      return undefined;
    }
    try {
      const fresh = collectActivityByDate(document, new Date());
      const headerCandidates: Array<{ tag: string; firstLine: string }> = [];
      for (const el of document.querySelectorAll('div')) {
        const text = (el as HTMLElement).innerText || el.textContent || '';
        const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
        if (!firstLine) continue;
        if (
          /^(今天|昨天|今日|Today|Yesterday)$/.test(firstLine) ||
          /^\d{1,2}月\d{1,2}日$/.test(firstLine) ||
          /^\d{4}年\d{1,2}月\d{1,2}日$/.test(firstLine) ||
          /^\d{1,2}\/\d{1,2}/.test(firstLine)
        ) {
          headerCandidates.push({ tag: el.tagName.toLowerCase(), firstLine });
        }
      }
      const cwizCount = document.querySelectorAll('c-wiz').length;
      sendResponse({
        ok: true,
        url: location.href,
        readyState: document.readyState,
        cwizCount,
        headerCandidatesCount: headerCandidates.length,
        headerCandidatesSample: headerCandidates.slice(0, 12),
        fresh,
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false;
  });
}
