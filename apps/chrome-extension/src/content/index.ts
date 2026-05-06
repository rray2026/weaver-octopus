import { claudeBackfillAdapter } from './backfill/claude.js';
import { geminiBackfillAdapter } from './backfill/gemini.js';
import { runBackfill } from './backfill/runner.js';
import { startClaudeFetchOrchestrator } from './claude-fetch-orchestrator.js';
import { startClaudeHeadersCache } from './claude-headers-cache.js';
import { startClaudeStaleListener } from './claude-stale.js';
import { startGeminiOrchestrator } from './gemini-orchestrator.js';
import { startOrchestrator } from './orchestrator.js';
import { ClaudeParser } from './providers/claude.js';
import { startContentDevLogForwarder } from './dev-log-content.js';
import type {
  BackfillProviderProgressPatch,
  BackgroundToContentMessage,
  ClaudeCaptureMode,
  ContentToBackgroundMessage,
  Provider,
} from '../types/index.js';

const CLAUDE_CAPTURE_MODE_KEY = 'claudeCaptureMode';

// One content.js bundle is shared between claude.ai and gemini.google.com
// (single Vite entry → single Rollup chunk → no shared-module split, which
// would otherwise break content-script loading). Branch on hostname here.
if (__WEAVER_DEV__) startContentDevLogForwarder(`content:${location.hostname}`);

try {
  const host = location.hostname;
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    // Capture identity headers from any intercepted /api/* call. This runs
    // unconditionally (even in 'intercept' mode) so that switching to
    // 'fetch' mode later finds a fresh header set.
    startClaudeHeadersCache();
    // Listen for SPA mutations on chat URLs (send-message, rename, delete)
    // and invalidate the per-conversation hash so the next observed GET
    // produces a fresh download. Otherwise hash dedup suppresses updates.
    startClaudeStaleListener();
    void startClaudeWithConfiguredMode();
    installBackfillListener('claude');
  } else if (host === 'gemini.google.com' || host.endsWith('.gemini.google.com')) {
    startGeminiOrchestrator();
    installBackfillListener('gemini');
  } else {
    console.warn('[weaver] content script loaded on unexpected host', host);
  }
} catch (err) {
  console.error('[weaver] failed to start orchestrator', err);
}

/** Reads the user's preferred capture mode from chrome.storage.local and
 *  starts the matching orchestrator. Mode changes only take effect on the
 *  next page load — that's surfaced in the popup UI as a hint. */
async function startClaudeWithConfiguredMode(): Promise<void> {
  let mode: ClaudeCaptureMode = 'intercept';
  try {
    const items = await chrome.storage.local.get(CLAUDE_CAPTURE_MODE_KEY);
    const raw = items[CLAUDE_CAPTURE_MODE_KEY];
    if (raw === 'intercept' || raw === 'fetch') mode = raw;
  } catch (err) {
    console.warn('[weaver] reading claudeCaptureMode failed, defaulting to intercept', err);
  }
  console.log('[weaver] claude capture mode:', mode);
  if (mode === 'fetch') {
    startClaudeFetchOrchestrator(new ClaudeParser());
  } else {
    startOrchestrator(new ClaudeParser());
  }
}

/** Listens for BACKFILL_RUN from the background coordinator and runs the
 *  matching provider's adapter. Only one backfill at a time per tab —
 *  re-runs are ignored while one is active. */
function installBackfillListener(provider: Provider): void {
  let running = false;
  chrome.runtime.onMessage.addListener((msg: BackgroundToContentMessage, _sender, sendResponse) => {
    if (msg.type === 'BACKFILL_PING') {
      let version: string | undefined;
      let extensionId: string | undefined;
      try {
        version = chrome.runtime.getManifest().version;
        extensionId = chrome.runtime.id;
      } catch {
        // chrome.runtime.* throws "Extension context invalidated" after the
        // extension was reloaded mid-session. Reply anyway — the background's
        // version check below will then detect the mismatch and reload.
      }
      sendResponse({ ok: true, provider, version, extensionId });
      return false;
    }
    if (msg.type !== 'BACKFILL_RUN' || msg.provider !== provider) return undefined;
    if (running) {
      sendResponse({ ok: false, error: 'backfill already running' });
      return false;
    }
    running = true;
    const adapter = provider === 'claude' ? claudeBackfillAdapter : geminiBackfillAdapter;
    runBackfill(adapter, {
      minIntervalMs: msg.minIntervalMs,
      maxIntervalMs: msg.maxIntervalMs,
      perChatTimeoutMs: msg.perChatTimeoutMs,
      stopAfterConsecutiveDateSkips: msg.stopAfterConsecutiveDateSkips,
      mode: msg.mode,
      reportPatch: (patch: BackfillProviderProgressPatch) =>
        chrome.runtime
          .sendMessage({
            type: 'BACKFILL_PROGRESS',
            provider,
            patch,
          } satisfies ContentToBackgroundMessage)
          .catch(() => undefined),
    })
      .then(() => {
        running = false;
        sendResponse({ ok: true });
      })
      .catch((err) => {
        running = false;
        console.error('[weaver:backfill] runner threw', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // keep the message channel open for async sendResponse
  });
}
