export type Provider = 'claude' | 'gemini';

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
    };

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
