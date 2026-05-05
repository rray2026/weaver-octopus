// Reusable "fetch + process one Claude conversation by id" core.
//
// Used by:
// - claude-fetch-orchestrator (live capture, URL-change-driven)
// - claudeBackfillAdapter in 'fetch' mode (batch backfill, called per chat
//   instead of clicking the sidebar link)
//
// State (hash dedup map, cached orgId) is round-tripped through
// chrome.storage.local on every call so concurrent callers don't drift.
// The cost is small (one storage.get + one storage.set per call) and the
// architecture stays stateless across orchestrator vs backfill.

import { dispatchCaptureDecision } from './captureEvents.js';
import { getCachedClaudeHeaders } from './claude-headers-cache.js';
import { computeRange, loadFilter } from './dateFilter.js';
import { hashString } from './hash.js';
import { messagesToMarkdown, sanitizeFilename, todayDateString } from './markdown.js';
import type { ProviderParser } from './providers/types.js';

const HASH_STORAGE_KEY = 'convHashes';
const ORG_ID_STORAGE_KEY = 'claudeOrgId';

export interface ProcessClaudeChatOptions {
  /** Override `window.fetch` (for tests / alternative networks). */
  fetchImpl?: typeof fetch;
  /** Override `document.title` resolution (test-friendly). */
  documentTitle?: string;
  /** Override the URL the orchestrator records as the source href. */
  url?: string;
  /** Optional structured tag prefix for log lines. */
  logTag?: string;
}

/** Outcomes the caller can observe directly (CAPTURE_DECISION is also fired
 *  for in-tab listeners). */
export type ProcessClaudeChatResult =
  | { kind: 'downloaded' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; reason: string };

/** Fetches the named Claude conversation, runs it through the shared
 *  parse → date filter → hash → download pipeline, and broadcasts a
 *  CAPTURE_DECISION event. Returns a structured result so callers (esp.
 *  the backfill adapter) can short-circuit their own waits. */
export async function processClaudeChatById(
  chatId: string,
  parser: ProviderParser,
  opts: ProcessClaudeChatOptions = {},
): Promise<ProcessClaudeChatResult> {
  const fetchImpl = opts.fetchImpl ?? ((...args) => window.fetch(...args));
  const tag = opts.logTag ?? '[weaver:claude-fetch-core]';

  const orgId = await ensureOrgId(fetchImpl, tag);
  if (!orgId) {
    const reason = 'org id unavailable (login required?)';
    dispatchCaptureDecision({
      provider: 'claude',
      conversationId: chatId,
      action: 'skipped:other',
      reason,
    });
    return { kind: 'error', reason };
  }

  let body: unknown;
  try {
    const url = `/api/organizations/${orgId}/chat_conversations/${chatId}`;
    console.log(tag, 'fetching', url);
    const res = await authedFetch(fetchImpl, url);
    if (!res.ok) {
      const reason = `fetch ${res.status}`;
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:other',
        reason,
      });
      return { kind: 'error', reason };
    }
    body = await res.json();
  } catch (err) {
    const reason =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    dispatchCaptureDecision({
      provider: 'claude',
      conversationId: chatId,
      action: 'skipped:other',
      reason: `fetch failed: ${reason}`,
    });
    return { kind: 'error', reason };
  }

  return processClaudeBody(chatId, body, parser, opts);
}

/** Processes a conversation body that's already in hand (used by the live
 *  fetch orchestrator after its own fetch, and by tests). Same pipeline as
 *  the intercept orchestrator's handleConversation. */
export async function processClaudeBody(
  chatId: string,
  body: unknown,
  parser: ProviderParser,
  opts: ProcessClaudeChatOptions = {},
): Promise<ProcessClaudeChatResult> {
  const tag = opts.logTag ?? '[weaver:claude-fetch-core]';
  try {
    const docTitle =
      opts.documentTitle ??
      (typeof document !== 'undefined' ? document.title : '');
    const fallbackTitle = docTitle.replace(/\s*[-–]\s*Claude\s*$/, '').trim();
    const sourceUrl =
      opts.url ?? (typeof location !== 'undefined' ? location.href : '');
    const conv = parser.parseConversation(body, sourceUrl, fallbackTitle);
    if (!conv) {
      const reason = 'parser returned null';
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:other',
        reason,
      });
      return { kind: 'skipped', reason };
    }

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
      const reason = `no messages within ${range.label}`;
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:date',
        reason,
      });
      return { kind: 'skipped', reason };
    }

    const markdown = messagesToMarkdown(inRange, conv.title, conv.url, range.label);
    const newHash = await hashString(markdown);
    const hashes = await loadHashes();
    if (hashes[chatId] === newHash) {
      const reason = 'identical content already downloaded';
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:hash',
        reason,
      });
      return { kind: 'skipped', reason };
    }
    hashes[chatId] = newHash;
    await saveHashes(hashes);

    const idSuffix = chatId.slice(0, 8);
    const filename = `weaver-octopus/${todayDateString()}/[claude] ${sanitizeFilename(conv.title)}-${idSuffix}.md`;
    console.log(tag, 'sending DOWNLOAD_REQUEST', {
      filename,
      bytes: markdown.length,
      inRange: inRange.length,
    });
    const ack = (await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_REQUEST',
      filename,
      content: markdown,
    })) as { ok?: boolean; error?: string; downloadId?: number } | undefined;
    if (!ack || !ack.ok) {
      const reason = `background rejected download${ack?.error ? `: ${ack.error}` : ''}`;
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: chatId,
        action: 'skipped:other',
        reason,
      });
      return { kind: 'error', reason };
    }
    dispatchCaptureDecision({
      provider: 'claude',
      conversationId: chatId,
      action: 'downloaded',
    });
    return { kind: 'downloaded' };
  } catch (err) {
    const reason =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(tag, 'processClaudeBody failed', err);
    dispatchCaptureDecision({
      provider: 'claude',
      conversationId: chatId,
      action: 'skipped:other',
      reason,
    });
    return { kind: 'error', reason };
  }
}

async function ensureOrgId(fetchImpl: typeof fetch, tag: string): Promise<string | null> {
  try {
    const items = await chrome.storage.local.get(ORG_ID_STORAGE_KEY);
    const cached = items[ORG_ID_STORAGE_KEY] as string | undefined;
    if (cached) return cached;
  } catch {
    /* fall through to discovery */
  }

  try {
    console.log(tag, 'discovering org id via /api/organizations');
    const res = await authedFetch(fetchImpl, '/api/organizations');
    if (!res.ok) return null;
    const orgs = (await res.json()) as Array<{ uuid?: string; id?: string }>;
    if (!Array.isArray(orgs) || orgs.length === 0) return null;
    const first = orgs[0]!;
    const id = first.uuid ?? first.id ?? null;
    if (!id) return null;
    try {
      await chrome.storage.local.set({ [ORG_ID_STORAGE_KEY]: id });
    } catch {
      /* non-fatal */
    }
    return id;
  } catch (err) {
    console.warn(tag, 'org discovery failed', err);
    return null;
  }
}

/** Issues a fetch to a Claude API endpoint with the same identity headers
 *  the SPA itself uses (captured by the MAIN-world intercept). Without these
 *  Claude returns 403 even with valid cookies. */
async function authedFetch(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  const cached = await getCachedClaudeHeaders();
  const headers = new Headers(cached ?? {});
  // Claude expects Accept: application/json on these endpoints; harmless if
  // the cached set already includes it.
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  return fetchImpl(url, {
    credentials: 'include',
    headers,
  });
}

async function loadHashes(): Promise<Record<string, string>> {
  try {
    const items = await chrome.storage.local.get(HASH_STORAGE_KEY);
    const stored = items[HASH_STORAGE_KEY] as Record<string, string> | undefined;
    return stored ? { ...stored } : {};
  } catch {
    return {};
  }
}

async function saveHashes(hashes: Record<string, string>): Promise<void> {
  await chrome.storage.local.set({ [HASH_STORAGE_KEY]: hashes });
}
