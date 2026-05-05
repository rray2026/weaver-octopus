export type Provider = 'claude' | 'gemini';

/** How the Claude content script captures conversations.
 *  - 'intercept' (default): MAIN-world fetch monkey-patch observes the SPA's
 *    own conversation requests. Zero extra requests, but capture only fires
 *    when the SPA actually re-fetches (cache hits skip us).
 *  - 'fetch': URL-change listener triggers an explicit GET via the page's
 *    own fetch (same-origin, credentials included). Independent of the
 *    SPA's caching — better for backfill — but issues one extra request
 *    per chat visit. */
export type ClaudeCaptureMode = 'intercept' | 'fetch';

/** Today's prompt list scraped from myactivity.google.com/product/gemini.
 *  Used by the Gemini DOM scraper to identify which conversation turns were
 *  sent today (Gemini's DOM has no per-turn timestamps). */
export interface TodayGeminiPrompts {
  /** YYYY-MM-DD (local). */
  date: string;
  /** Prompt strings, newest-first as they appear in myactivity. */
  prompts: string[];
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
      /** 'click' (default): simulate a sidebar click and let the live
       *  orchestrator capture; 'fetch' (Claude only): bypass the sidebar and
       *  call the conversation API directly. */
      mode: 'click' | 'fetch';
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
    };

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
