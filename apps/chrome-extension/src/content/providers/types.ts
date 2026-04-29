import type { ChatMessage } from '../../types/index.js';

export interface ConversationData {
  title: string;
  url: string;
  messages: ChatMessage[];
}

export interface ProviderParser {
  /** Parses a raw conversation API response body into a normalized form.
   *  Returns null if the body doesn't look like a conversation (e.g. wrong shape). */
  parseConversation(body: unknown, url: string, fallbackTitle: string): ConversationData | null;
}
