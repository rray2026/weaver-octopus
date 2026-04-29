export type Provider = 'claude';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ms since epoch — when the message was created on the provider side. */
  createdAt: number;
}

export type ContentToBackgroundMessage = {
  type: 'DOWNLOAD_REQUEST';
  filename: string;
  content: string;
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
