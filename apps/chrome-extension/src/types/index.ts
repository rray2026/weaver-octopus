export type Provider = 'claude' | 'gemini' | 'chatgpt';

/** A single day's prompts scraped from myactivity.google.com/product/gemini.
 *  Days are listed in display order (newest first). */
export interface GeminiActivityDay {
  /** YYYY-MM-DD (local). */
  date: string;
  /** Prompt strings, newest-first as they appear in myactivity. */
  prompts: string[];
}

/** Multi-day index of Gemini prompts scraped from myactivity. The Gemini
 *  DOM has no per-turn timestamps, so we use myactivity's per-day buckets
 *  to decide which user-turns of a chat fall in the user's date filter. */
export interface GeminiActivityIndex {
  /** ISO timestamp when this snapshot was captured. */
  scrapedAt: string;
  /** Days in display order (newest first). */
  days: GeminiActivityDay[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ms since epoch — when the message was created on the provider side. */
  createdAt: number;
}

export type ContentToBackgroundMessage =
  | {
      type: 'DOWNLOAD_REQUEST';
      filename: string;
      content: string;
    }
  | {
      /** Sent by the Gemini content script when it needs a fresh today-prompt
       *  list. Background opens or reloads the myactivity tab in the
       *  background (does not steal focus). Throttled to once per 30s. */
      type: 'REFRESH_ACTIVITY';
    }
  | {
      /** Backfill content script reports progress / logs to the background
       *  coordinator, which aggregates per-provider state into storage so the
       *  popup can render live updates and survive close+reopen. */
      type: 'BACKFILL_PROGRESS';
      provider: Provider;
      patch: BackfillProviderProgressPatch;
    };

export type BackgroundToContentMessage =
  | {
      /** Sent by the background to a provider's content script to enter
       *  backfill mode. Content script enumerates sidebar chats, navigates
       *  through them, and waits for the orchestrator to emit a download
       *  per chat. */
      type: 'BACKFILL_RUN';
      provider: Provider;
      /** Min ms to wait between chats. Actual wait is jittered up to maxIntervalMs. */
      minIntervalMs: number;
      maxIntervalMs: number;
      /** Hard cap per chat — if no download is observed within this window,
       *  the entry is logged as "skipped" and we move on. */
      perChatTimeoutMs: number;
      /** Stop the rest of the batch after this many consecutive `skipped:date`
       *  outcomes (sidebar is date-sorted past the pinned section). 0 disables. */
      stopAfterConsecutiveDateSkips: number;
    }
  | {
      type: 'BACKFILL_STOP';
    }
  | {
      /** Lightweight liveness probe. Background sends this before BACKFILL_RUN
       *  to verify the freshest content script is loaded — if the tab carries
       *  a stale build (extension was updated mid-session) the listener for
       *  this message simply isn't registered and chrome.tabs.sendMessage
       *  rejects, signalling the background to reload the tab. */
      type: 'BACKFILL_PING';
    }
  | {
      /** Dev-only — dispatched by `dev:trigger '{"action":"snapshot-dom"}'`.
       *  Content script returns a structured dump of the current chat DOM
       *  (turn texts, selector hits with truncated outerHTML, sidebar
       *  links) so the developer can inspect Gemini/Claude DOM structure
       *  offline. Tree-shaken in production. */
      type: 'SNAPSHOT_DOM';
    };

export interface DomSnapshotResult {
  url: string;
  hostname: string;
  title: string;
  turnsCount: number;
  /** scrapeTurns() output — text only, no HTML. */
  turns: Array<{ userText: string; modelText: string }>;
  /** For each candidate selector, count + outerHTML of the first hit
   *  (truncated to 800 chars). Lets us see which selectors are matching
   *  and inspect their actual structure. */
  selectorProbes: Array<{ selector: string; count: number; firstOuterHtmlTruncated?: string }>;
  /** sidebar links the backfill adapter would enumerate. */
  sidebar: Array<{ href: string; title?: string }>;
}

export interface BackfillPingAck {
  ok: true;
  provider: Provider;
  /** Manifest version of the *content script's* extension context. Used by
   *  the background to detect a tab carrying a stale build after the
   *  extension was reloaded — the new background will read a newer version
   *  from its own manifest and force a tab reload to refresh content.js. */
  version?: string;
  /** Extension id of the content script's runtime — guards against confusion
   *  if multiple Weaver-Octopus-flavoured extensions are installed at once. */
  extensionId?: string;
}

export interface LastDownload {
  filename: string;
  at: number;
}

export type DateFilterType = 'today' | 'yesterday' | 'last7days' | 'thisWeek' | 'range';

export interface DateFilter {
  type: DateFilterType;
  /** YYYY-MM-DD (local), only meaningful when type === 'range'. */
  start?: string;
  /** YYYY-MM-DD (local), inclusive end day. Only meaningful when type === 'range'. */
  end?: string;
}

// ─── Backfill ────────────────────────────────────────────────────────────────

export type BackfillState = 'idle' | 'running' | 'stopping' | 'done' | 'error';

export type BackfillEntryStatus = 'ok' | 'skipped' | 'failed';

export interface BackfillLogEntry {
  at: number;
  provider: Provider;
  title?: string;
  href?: string;
  status: BackfillEntryStatus;
  reason?: string;
}

export interface BackfillProviderProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** Title of the chat currently being processed. Cleared at end. */
  currentTitle?: string;
  /** Capped to MAX_LOG_PER_PROVIDER entries (newest-first). */
  log: BackfillLogEntry[];
}

/** A partial that the background applies onto the persisted provider state.
 *  Patches are additive — log entries are appended, counters are absolute. */
export interface BackfillProviderProgressPatch {
  total?: number;
  done?: number;
  failed?: number;
  skipped?: number;
  currentTitle?: string | null;
  appendLog?: BackfillLogEntry[];
}

export interface BackfillProgress {
  state: BackfillState;
  startedAt?: number;
  finishedAt?: number;
  /** Last fatal error or sticky note shown to the user. */
  errorMessage?: string;
  perProvider: { [k in Provider]?: BackfillProviderProgress };
}
