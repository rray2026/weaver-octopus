// Active-fetch orchestrator for Claude (alternative to passive intercept).
//
// Triggers on URL change. When the URL points to /chat/<uuid>, calls the
// shared `processClaudeChatById` core which fetches the conversation, runs
// it through parse → date filter → hash dedup → download, and broadcasts a
// CAPTURE_DECISION event.
//
// Tradeoffs vs the intercept orchestrator:
// - Pro: independent of SPA caching — every chat visit produces a request,
//   so backfill never stalls on cached pages.
// - Pro: works even when the SPA never refetches (e.g. sticky single-page
//   sessions).
// - Con: one extra network request per chat visit. Same endpoint Claude's
//   own SPA hits, so not a new traffic pattern.

import { processClaudeChatById } from './claude-fetch-core.js';
import { dispatchCaptureDecision } from './captureEvents.js';
import type { ProviderParser } from './providers/types.js';

const TAG = '[weaver:claude-fetch]';
const TRIGGER_DEBOUNCE_MS = 400;
const CHAT_PATH_RE = /^\/chat\/([0-9a-f-]{36})/i;

export interface ClaudeFetchOrchestratorOptions {
  triggerDebounceMs?: number;
  /** Override the network for tests. Defaults to the page's own `fetch`. */
  fetchImpl?: typeof fetch;
}

export function startClaudeFetchOrchestrator(
  parser: ProviderParser,
  options: ClaudeFetchOrchestratorOptions = {},
): () => void {
  const triggerDebounceMs = options.triggerDebounceMs ?? TRIGGER_DEBOUNCE_MS;

  console.log(TAG, 'started', { origin: location.origin, href: location.href });

  let extensionInvalidated = false;
  let pendingTrigger: ReturnType<typeof setTimeout> | null = null;
  // Avoid re-fetching the same chat on rapid push/replaceState fires. We
  // *do* re-process when the URL changes back to a known id (so reopening a
  // chat after navigating away works).
  let lastSeenChatId: string | null = null;
  // Single in-flight: history hooks can fire several times during one
  // navigation; we only want one fetch per chat-id transition.
  let processChain: Promise<void> = Promise.resolve();

  const detachHistoryHooks = installHistoryHooks(() => schedule());
  // Initial poke — content script may load on a chat URL already.
  schedule();

  return () => {
    detachHistoryHooks();
    if (pendingTrigger) clearTimeout(pendingTrigger);
  };

  function schedule(): void {
    if (extensionInvalidated) return;
    if (pendingTrigger) clearTimeout(pendingTrigger);
    pendingTrigger = setTimeout(() => {
      pendingTrigger = null;
      processChain = processChain.then(handleUrlChange);
    }, triggerDebounceMs);
  }

  async function handleUrlChange(): Promise<void> {
    if (extensionInvalidated) return;
    const match = location.pathname.match(CHAT_PATH_RE);
    const chatId = match ? match[1]! : null;
    if (!chatId) {
      lastSeenChatId = null;
      return;
    }
    if (chatId === lastSeenChatId) {
      console.log(TAG, 'skip: chat id unchanged since last trigger', { chatId });
      return;
    }
    lastSeenChatId = chatId;

    try {
      await processClaudeChatById(chatId, parser, {
        fetchImpl: options.fetchImpl,
        logTag: `${TAG}#${chatId.slice(0, 8)}`,
      });
    } catch (err) {
      if (isExtensionInvalidated(err)) {
        markInvalidated();
        return;
      }
      const reason =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(TAG, 'processClaudeChatById threw', err);
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:other',
        reason,
      });
    }
  }

  function markInvalidated(): void {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    console.warn(TAG, 'extension was reloaded — refresh this tab to resume');
  }
}

function installHistoryHooks(onChange: () => void): () => void {
  const EVENT = 'weaver-claude-locationchange';
  const fire = (): void => {
    window.dispatchEvent(new Event(EVENT));
  };
  type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;
  const orig = {
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

function isExtensionInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Extension context invalidated');
}
