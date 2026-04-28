import type { ChatMessage } from '../../types/index.js';
import type { ProviderScraper } from './types.js';

export class ClaudeScraper implements ProviderScraper {
  isStreaming(): boolean {
    return document.querySelector('[data-testid="stop-button"]') !== null;
  }

  scrapeMessages(): ChatMessage[] {
    const messages: ChatMessage[] = [];

    const userEls = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
    const assistantEls = Array.from(
      document.querySelectorAll('.font-claude-message, [data-testid="assistant-message"]'),
    );

    // Interleave user and assistant turns by DOM order
    const allEls: Array<{ el: Element; role: 'user' | 'assistant' }> = [
      ...userEls.map((el) => ({ el, role: 'user' as const })),
      ...assistantEls.map((el) => ({ el, role: 'assistant' as const })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    for (let i = 0; i < allEls.length; i++) {
      const { el, role } = allEls[i]!;
      const content = el.textContent?.trim() ?? '';
      if (!content) continue;
      messages.push({
        id: `${role}-${i}`,
        role,
        content,
        timestamp: Date.now(),
      });
    }

    return messages;
  }

  getTitle(): string {
    return document.title.replace(/\s*[-–]\s*Claude\s*$/, '').trim() || 'Untitled';
  }
}
