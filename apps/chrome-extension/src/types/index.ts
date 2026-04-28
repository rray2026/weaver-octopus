export type Provider = 'gemini' | 'chatgpt' | 'claude';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  provider: Provider;
  url: string;
  title: string;
  messages: ChatMessage[];
  capturedAt: number;
  updatedAt: number;
}

export type ContentToBackgroundMessage =
  | { type: 'SESSION_UPDATE'; session: ChatSession }
  | { type: 'SESSION_START'; session: ChatSession };

export type BackgroundToContentMessage =
  | { type: 'PING' };
