// Listens for API_HEADERS messages from the MAIN-world intercept and stashes
// the latest set in chrome.storage.local. The fetch-mode orchestrator + the
// backfill adapter read these headers when they make their own API calls —
// without anthropic-* identity headers Claude returns 403 even with valid
// cookies.
//
// This module is import-free of orchestrator state on purpose: it just
// observes a postMessage stream and persists. Callers read via
// `getCachedClaudeHeaders()`.

const SOURCE = 'weaver-octopus:intercept';
const STORAGE_KEY = 'claudeApiHeaders';
const TAG = '[weaver:claude-headers]';

interface ApiHeadersMessage {
  source: typeof SOURCE;
  type: 'API_HEADERS';
  headers: Record<string, string>;
}

let inMemory: Record<string, string> | null = null;

/** Wires the postMessage listener that captures headers. Idempotent. */
export function startClaudeHeadersCache(): () => void {
  // Hydrate from storage so even the first page-load (before any intercept
  // fires) gets the previous session's headers.
  void chrome.storage.local
    .get(STORAGE_KEY)
    .then((items) => {
      const v = items[STORAGE_KEY] as Record<string, string> | undefined;
      if (v && Object.keys(v).length > 0) inMemory = v;
    })
    .catch(() => undefined);

  const listener = (event: MessageEvent): void => {
    if (event.origin !== location.origin) return;
    const data = event.data as ApiHeadersMessage | undefined;
    if (!data || data.source !== SOURCE || data.type !== 'API_HEADERS') return;
    if (!data.headers || Object.keys(data.headers).length === 0) return;
    inMemory = data.headers;
    console.log(TAG, 'captured', Object.keys(data.headers).sort());
    chrome.storage.local
      .set({ [STORAGE_KEY]: data.headers })
      .catch((err) => console.warn(TAG, 'persist failed', err));
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Returns the most recently captured Claude API auth/identity headers, or
 *  null if no SPA call has been intercepted yet (and storage is empty). */
export async function getCachedClaudeHeaders(): Promise<Record<string, string> | null> {
  if (inMemory) return inMemory;
  try {
    const items = await chrome.storage.local.get(STORAGE_KEY);
    const stored = items[STORAGE_KEY] as Record<string, string> | undefined;
    if (stored && Object.keys(stored).length > 0) {
      inMemory = stored;
      return stored;
    }
  } catch {
    /* ignore */
  }
  return null;
}
