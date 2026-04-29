import type { ChatMessage } from '../../types/index.js';
import type { ConversationData, ProviderParser } from './types.js';

interface ApiContentBlock {
  type: string;
  text?: string;
}

interface ApiMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  created_at: string;
  content: ApiContentBlock[];
}

interface ApiConversation {
  uuid: string;
  name?: string;
  chat_messages: ApiMessage[];
}

export class ClaudeParser implements ProviderParser {
  parseConversation(body: unknown, url: string, fallbackTitle: string): ConversationData | null {
    if (!isApiConversation(body)) return null;

    const messages: ChatMessage[] = body.chat_messages
      .map((m) => ({
        id: m.uuid,
        role: (m.sender === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: extractText(m.content),
        createdAt: Date.parse(m.created_at),
      }))
      .filter((m) => m.content.length > 0);

    return {
      title: body.name?.trim() || fallbackTitle || 'Untitled',
      url,
      messages,
    };
  }
}

function isApiConversation(body: unknown): body is ApiConversation {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { chat_messages?: unknown }).chat_messages)
  );
}

function extractText(content: ApiContentBlock[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}
