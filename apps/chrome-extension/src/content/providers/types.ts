import type { ChatMessage } from '../../types/index.js';

export interface ProviderScraper {
  /** Returns true when generation is in progress (e.g. Stop button visible). */
  isStreaming(): boolean;
  /** Scrapes all current messages from the DOM. Returns empty array if DOM not ready. */
  scrapeMessages(): ChatMessage[];
  /** Extracts the chat title from the page. */
  getTitle(): string;
}
