import { computeRange, loadFilter } from './dateFilter.js';
import { hashString } from './hash.js';
import { messagesToMarkdown, sanitizeFilename, todayDateString } from './markdown.js';
import type { ProviderParser } from './providers/types.js';

const INTERCEPT_SOURCE = 'weaver-octopus:intercept';
const HASH_STORAGE_KEY = 'convHashes';
const TAG = '[weaver:orch]';

interface InterceptedMessage {
  source: typeof INTERCEPT_SOURCE;
  type: 'CONVERSATION';
  conversationId: string;
  body: unknown;
}

/**
 * Wires up MAIN-world fetch interception → markdown download.
 * Returns a teardown function that removes both event listeners.
 */
export function startOrchestrator(parser: ProviderParser): () => void {
  console.log(TAG, 'started', { origin: location.origin, href: location.href });
  let seq = 0;
  // Hash is per-conversation: navigating to a different chat resets it so a
  // fresh conversation isn't suppressed by a stale hash. Persisted to
  // chrome.storage.local so refreshing the tab doesn't redownload identical
  // content, and so the popup's Reset button can clear it externally.
  const lastHashByConv = new Map<string, string>();
  // Serialize processing so two events arriving back-to-back (e.g. when the
  // user switches between conversations and Claude refetches both) don't race
  // each other through the hash check + download path. We chain promises
  // rather than using a boolean — a boolean would silently drop events.
  let processChain: Promise<void> = Promise.resolve();
  // Set after the extension is reloaded mid-session — chrome.runtime calls from
  // this stale content script will throw "Extension context invalidated" until
  // the tab is refreshed. We disable further work to avoid log spam.
  let extensionInvalidated = false;

  // Held so handleConversation can await the initial load — otherwise an
  // event firing during hydration could race past the dedup check.
  const hydrationPromise = hydrateHashes();

  const storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (extensionInvalidated) return;
    if (area !== 'local' || !changes[HASH_STORAGE_KEY]) return;
    // Mirror external writes (popup's Reset, another tab) into the in-memory
    // map so dedup decisions stay consistent. We do NOT auto-redownload here
    // — re-downloads happen when the user revisits a chat (page refresh, or
    // SPA navigation that triggers Claude's refetch).
    const next = changes[HASH_STORAGE_KEY].newValue as Record<string, string> | undefined;
    lastHashByConv.clear();
    if (next) {
      for (const [k, v] of Object.entries(next)) lastHashByConv.set(k, v);
      console.log(TAG, 'storage convHashes mirrored', { count: lastHashByConv.size });
    } else {
      console.log(TAG, 'convHashes cleared — refresh a chat tab to redownload');
    }
  };
  chrome.storage.onChanged.addListener(storageListener);

  const messageListener = (event: MessageEvent): void => {
    if (extensionInvalidated) {
      console.log(TAG, 'drop msg: extension invalidated');
      return;
    }
    // Note: don't compare event.source to `window`. Across MV3 worlds (the
    // intercept script runs in MAIN, this listener in ISOLATED) the two
    // window proxies are not === equal, so that check would reject every
    // real intercept. Origin + the string sentinel below are sufficient.
    if (event.origin !== location.origin) return;
    const data = event.data as InterceptedMessage | undefined;
    if (!data || data.source !== INTERCEPT_SOURCE || data.type !== 'CONVERSATION') return;
    console.log(TAG, 'received intercept msg', { conversationId: data.conversationId });
    enqueue(data);
  };
  window.addEventListener('message', messageListener);

  return () => {
    window.removeEventListener('message', messageListener);
    chrome.storage.onChanged.removeListener(storageListener);
  };

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

  function enqueue(msg: InterceptedMessage): void {
    processChain = processChain.then(() => handleConversation(msg));
  }

  async function persistHashes(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of lastHashByConv) obj[k] = v;
    await chrome.storage.local.set({ [HASH_STORAGE_KEY]: obj });
  }

  async function handleConversation(msg: InterceptedMessage): Promise<void> {
    const id = ++seq;
    const tag = `${TAG}#${id}`;
    console.log(tag, 'handle start', { conversationId: msg.conversationId });
    await hydrationPromise;
    if (extensionInvalidated) {
      console.log(tag, 'skip: invalidated after hydration');
      return;
    }
    try {
      const fallbackTitle = document.title.replace(/\s*[-–]\s*Claude\s*$/, '').trim();
      const conv = parser.parseConversation(msg.body, location.href, fallbackTitle);
      if (!conv) {
        console.log(tag, 'skip: parser returned null (body shape mismatch)');
        return;
      }
      console.log(tag, 'parsed', { title: conv.title, messageCount: conv.messages.length });

      const filter = await loadFilter();
      const range = computeRange(filter, new Date());
      const inRange = conv.messages.filter(
        (m) => m.createdAt >= range.start && m.createdAt < range.end,
      );
      console.log(tag, 'date filter', {
        filter: filter.type,
        rangeLabel: range.label,
        inRange: inRange.length,
        total: conv.messages.length,
      });
      if (inRange.length === 0) {
        console.log(tag, 'skip: no messages in date range');
        return;
      }

      const markdown = messagesToMarkdown(inRange, conv.title, conv.url, range.label);
      const newHash = await hashString(markdown);
      const prevHash = lastHashByConv.get(msg.conversationId);
      if (prevHash === newHash) {
        console.log(tag, 'skip: hash unchanged (already downloaded)', {
          hash: newHash.slice(0, 8),
        });
        return;
      }
      console.log(tag, 'hash decision', {
        new: newHash.slice(0, 8),
        prev: prevHash?.slice(0, 8) ?? '(none)',
      });
      lastHashByConv.set(msg.conversationId, newHash);
      await persistHashes();

      // Suffix the conversation id (first 8 hex chars) so two chats with the
      // same title on the same day don't overwrite each other.
      const idSuffix = msg.conversationId.slice(0, 8);
      const filename = `weaver-octopus/${todayDateString()}/[claude] ${sanitizeFilename(conv.title)}-${idSuffix}.md`;
      console.log(tag, 'sending DOWNLOAD_REQUEST', {
        filename,
        bytes: markdown.length,
        inRange: inRange.length,
        total: conv.messages.length,
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
        console.log(tag, 'download acked by background', { downloadId: ack.downloadId });
      } catch (sendErr) {
        if (isExtensionInvalidated(sendErr)) {
          markInvalidated();
          return;
        }
        console.error(tag, 'sendMessage to background failed', sendErr);
      }
    } catch (err) {
      if (isExtensionInvalidated(err)) {
        markInvalidated();
        return;
      }
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(tag, 'capture failed —', reason, err);
    }
  }

  function markInvalidated(): void {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    console.warn(TAG, 'extension was reloaded — refresh this tab to resume capture');
  }
}

function isExtensionInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Extension context invalidated');
}
