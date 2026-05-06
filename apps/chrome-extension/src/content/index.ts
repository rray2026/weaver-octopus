import { chatgptBackfillAdapter, collectChatGPTChatLinks } from './backfill/chatgpt.js';
import { claudeBackfillAdapter, collectClaudeChatLinks } from './backfill/claude.js';
import { geminiBackfillAdapter, collectGeminiChatLinks } from './backfill/gemini.js';
import { runBackfill } from './backfill/runner.js';
import { startClaudeStaleListener } from './claude-stale.js';
import { startGeminiOrchestrator } from './gemini-orchestrator.js';
import { setBackfillInFlight } from './live-capture-gate.js';
import { startOrchestrator } from './orchestrator.js';
import { ChatGPTParser } from './providers/chatgpt.js';
import { ClaudeParser } from './providers/claude.js';
import { startDevForwarder as startContentDevLogForwarder } from '@weaver-octopus/ext-dev-rpc/content';
import { captureDomSnapshot as devCaptureDomSnapshot } from '../dev/dom-snapshot.js';
import { scrapeTurns as scrapeGeminiTurns } from './providers/gemini.js';
import type {
  BackfillProviderProgressPatch,
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  Provider,
} from '../types/index.js';

// One content.js bundle is shared between claude.ai and gemini.google.com
// (single Vite entry → single Rollup chunk → no shared-module split, which
// would otherwise break content-script loading). Branch on hostname here.
if (__WEAVER_DEV__) startContentDevLogForwarder(`content:${location.hostname}`);

try {
  const host = location.hostname;
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    // Listen for SPA mutations on chat URLs (send-message, rename, delete)
    // and invalidate the per-conversation hash so the next observed GET
    // produces a fresh download. Otherwise hash dedup suppresses updates.
    startClaudeStaleListener();
    // Claude capture works exclusively via the MAIN-world fetch intercept —
    // a fetch-mode replay path was attempted and abandoned because Claude's
    // API rejects replayed requests with 403 even when all captured
    // anthropic-* identity headers are present.
    startOrchestrator(new ClaudeParser(), {
      provider: 'claude',
      interceptSource: 'weaver-octopus:intercept',
      titleStripRe: /\s*[-–]\s*Claude\s*$/,
    });
    installBackfillListener('claude');
  } else if (host === 'gemini.google.com' || host.endsWith('.gemini.google.com')) {
    startGeminiOrchestrator();
    installBackfillListener('gemini');
  } else if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) {
    // ChatGPT is backfill-only. The orchestrator runs and listens for
    // intercept events, but its `isLiveCaptureAllowed()` gate at the
    // entry of `handleConversation` drops everything unless backfill
    // is actually in flight (set via `setBackfillInFlight(true)` in
    // installBackfillListener below). Live-capture toggle on the popup
    // intentionally does not affect chatgpt.com — see PROVIDER notes.
    startOrchestrator(new ChatGPTParser(), {
      provider: 'chatgpt',
      interceptSource: 'weaver-octopus:chatgpt-intercept',
      titleStripRe: /\s*[-–]\s*ChatGPT\s*$/,
    });
    installBackfillListener('chatgpt');
  } else {
    console.warn('[weaver] content script loaded on unexpected host', host);
  }
} catch (err) {
  console.error('[weaver] failed to start orchestrator', err);
}

/** Listens for BACKFILL_RUN from the background coordinator and runs the
 *  matching provider's adapter. Only one backfill at a time per tab —
 *  re-runs are ignored while one is active. */
function installBackfillListener(provider: Provider): void {
  let running = false;
  chrome.runtime.onMessage.addListener((msg: BackgroundToContentMessage, _sender, sendResponse) => {
    if (msg.type === 'SNAPSHOT_DOM') {
      // Dev-only: dump the current chat DOM for offline analysis.
      // The whole branch is dead-code-eliminated in prod via __WEAVER_DEV__.
      if (!__WEAVER_DEV__) {
        sendResponse({ ok: false, error: 'snapshot only available in dev build' });
        return false;
      }
      const scrape =
        provider === 'gemini' ? () => scrapeGeminiTurns(document) : () => [];
      const enumerate = () => {
        if (provider === 'claude') return collectClaudeChatLinks(document);
        if (provider === 'gemini') return collectGeminiChatLinks(document);
        return collectChatGPTChatLinks(document);
      };
      try {
        const snapshot = devCaptureDomSnapshot(scrape, enumerate);
        sendResponse({ ok: true, snapshot });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return false;
    }
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
    // Allow the orchestrator's live-capture gate to fire while the
    // batch is in flight — backfill IS the orchestrator pipeline,
    // just driven by a navigation script instead of user clicks.
    setBackfillInFlight(true);
    const adapter =
      provider === 'claude'
        ? claudeBackfillAdapter
        : provider === 'gemini'
          ? geminiBackfillAdapter
          : chatgptBackfillAdapter;
    runBackfill(adapter, {
      minIntervalMs: msg.minIntervalMs,
      maxIntervalMs: msg.maxIntervalMs,
      perChatTimeoutMs: msg.perChatTimeoutMs,
      stopAfterConsecutiveDateSkips: msg.stopAfterConsecutiveDateSkips,
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
        setBackfillInFlight(false);
        sendResponse({ ok: true });
      })
      .catch((err) => {
        running = false;
        setBackfillInFlight(false);
        console.error('[weaver:backfill] runner threw', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // keep the message channel open for async sendResponse
  });
}
