// ISOLATED-side handler for STALE_CONVERSATION events posted by the MAIN-
// world intercept whenever it observes a mutating request (POST/PATCH/
// DELETE) to a Claude chat URL — typically the user just sent a message,
// renamed the title, or deleted a chat.
//
// The hash dedup map (chrome.storage.local 'convHashes') would otherwise
// suppress the next download because the OLD content's hash is still
// stored. This module clears that entry as soon as a mutation is seen,
// and exposes a hook subscribers can use to react to invalidations.

const SOURCE = 'weaver-octopus:intercept';
const HASH_STORAGE_KEY = 'convHashes';
const TAG = '[weaver:claude-stale]';

interface StaleMessage {
  source: typeof SOURCE;
  type: 'STALE_CONVERSATION';
  conversationId: string;
}

export type StaleListener = (conversationId: string) => void;

const subscribers = new Set<StaleListener>();
let installed = false;

/** Wires the postMessage listener (idempotent). The same listener is shared
 *  across orchestrators so we don't accumulate multiple. */
export function startClaudeStaleListener(): () => void {
  if (!installed) {
    installed = true;
    window.addEventListener('message', onMessage);
  }
  return () => {
    /* no-op: shared listener intentionally outlives any single orchestrator */
  };
}

/** Subscribe to STALE events. Returns an unsubscribe function. */
export function onClaudeStale(listener: StaleListener): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

async function onMessage(event: MessageEvent): Promise<void> {
  if (event.origin !== location.origin) return;
  const data = event.data as StaleMessage | undefined;
  if (!data || data.source !== SOURCE || data.type !== 'STALE_CONVERSATION') return;
  const { conversationId } = data;
  console.log(TAG, 'invalidating cached hash', { conversationId });
  // Persist invalidation so the live orchestrator's next observed GET on
  // this conversation produces a fresh download.
  try {
    const items = await chrome.storage.local.get(HASH_STORAGE_KEY);
    const stored = items[HASH_STORAGE_KEY] as Record<string, string> | undefined;
    if (stored && stored[conversationId] != null) {
      const next = { ...stored };
      delete next[conversationId];
      await chrome.storage.local.set({ [HASH_STORAGE_KEY]: next });
    }
  } catch (err) {
    console.warn(TAG, 'failed to invalidate hash in storage', err);
  }
  // Fan out to any subscribed listeners (currently none in production —
  // the storage write above is the only required side effect).
  for (const cb of subscribers) {
    try {
      cb(conversationId);
    } catch (err) {
      console.warn(TAG, 'subscriber threw', err);
    }
  }
}
