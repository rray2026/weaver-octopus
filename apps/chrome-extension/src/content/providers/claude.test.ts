import { describe, expect, it } from 'vitest';
import { ClaudeParser } from './claude.js';

const URL = 'https://claude.ai/chat/abc';

describe('ClaudeParser.parseConversation', () => {
  const parser = new ClaudeParser();

  it('parses a normal conversation with text blocks', () => {
    const body = {
      uuid: 'conv-1',
      name: 'Hello',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [{ type: 'text', text: 'hi' }],
        },
        {
          uuid: 'm2',
          sender: 'assistant',
          created_at: '2026-04-29T10:00:30.000Z',
          content: [{ type: 'text', text: 'hello!' }],
        },
      ],
    };
    const conv = parser.parseConversation(body, URL, '');
    expect(conv).toEqual({
      title: 'Hello',
      url: URL,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hi',
          createdAt: Date.parse('2026-04-29T10:00:00.000Z'),
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'hello!',
          createdAt: Date.parse('2026-04-29T10:00:30.000Z'),
        },
      ],
    });
  });

  it('returns null for non-conversation payloads', () => {
    expect(parser.parseConversation({}, URL, '')).toBeNull();
    expect(parser.parseConversation(null, URL, '')).toBeNull();
    expect(parser.parseConversation('garbage', URL, '')).toBeNull();
    expect(parser.parseConversation({ chat_messages: 'not-array' }, URL, '')).toBeNull();
  });

  it('skips non-text content blocks (e.g. thinking)', () => {
    const body = {
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'assistant',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [
            { type: 'thinking', text: 'reasoning…' },
            { type: 'text', text: 'visible answer' },
            { type: 'tool_use', text: 'tool stuff' },
          ],
        },
      ],
    };
    const conv = parser.parseConversation(body, URL, 'fallback');
    expect(conv?.messages).toHaveLength(1);
    expect(conv?.messages[0]?.content).toBe('visible answer');
  });

  it('joins multiple text blocks with double newline', () => {
    const body = {
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [
            { type: 'text', text: 'paragraph 1' },
            { type: 'text', text: 'paragraph 2' },
          ],
        },
      ],
    };
    const conv = parser.parseConversation(body, URL, '');
    expect(conv?.messages[0]?.content).toBe('paragraph 1\n\nparagraph 2');
  });

  it('drops messages whose content is entirely empty', () => {
    const body = {
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [{ type: 'thinking', text: 'private' }],
        },
        {
          uuid: 'm2',
          sender: 'assistant',
          created_at: '2026-04-29T10:00:30.000Z',
          content: [{ type: 'text', text: 'real reply' }],
        },
      ],
    };
    const conv = parser.parseConversation(body, URL, '');
    expect(conv?.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('uses fallback title when name is missing or blank', () => {
    const baseBody = {
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    };
    expect(parser.parseConversation(baseBody, URL, 'Tab Title')?.title).toBe('Tab Title');
    expect(
      parser.parseConversation({ ...baseBody, name: '   ' }, URL, 'Tab Title')?.title,
    ).toBe('Tab Title');
    expect(parser.parseConversation(baseBody, URL, '')?.title).toBe('Untitled');
  });

  it('prefers the API name over the fallback', () => {
    const body = {
      name: 'Real Name',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    };
    expect(parser.parseConversation(body, URL, 'Tab Title')?.title).toBe('Real Name');
  });

  it('maps human → user, assistant → assistant', () => {
    const body = {
      chat_messages: [
        {
          uuid: 'h',
          sender: 'human',
          created_at: '2026-04-29T10:00:00.000Z',
          content: [{ type: 'text', text: 'q' }],
        },
        {
          uuid: 'a',
          sender: 'assistant',
          created_at: '2026-04-29T10:00:30.000Z',
          content: [{ type: 'text', text: 'a' }],
        },
      ],
    };
    const roles = parser.parseConversation(body, URL, '')?.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
  });
});
