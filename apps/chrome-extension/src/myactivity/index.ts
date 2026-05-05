// Content script for myactivity.google.com/product/gemini.
// Scrapes today's prompt list out of the rendered DOM, debounced on
// MutationObserver events, and persists it to chrome.storage.local under
// the `todayGemini` key. The Gemini content script reads that key when it
// needs to figure out which conversation turns happened today.

import { collectTodayPrompts } from './scraper.js';
import type { TodayGeminiPrompts } from '../types/index.js';

const STORAGE_KEY = 'todayGemini';
const TAG = '[weaver:myactivity]';
const INITIAL_DELAY_MS = 1500;
const DEBOUNCE_MS = 1200;

let lastPayload = '';
let pending: ReturnType<typeof setTimeout> | null = null;

function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA');
}

async function flush(): Promise<void> {
  let prompts: string[];
  try {
    prompts = collectTodayPrompts(document);
  } catch (err) {
    console.warn(TAG, 'collectTodayPrompts threw', err);
    return;
  }
  const payload: TodayGeminiPrompts = { date: todayDateString(), prompts };
  const serialized = JSON.stringify(payload);
  if (serialized === lastPayload) return;
  lastPayload = serialized;
  console.log(TAG, 'today prompts', { count: prompts.length });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: payload });
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
