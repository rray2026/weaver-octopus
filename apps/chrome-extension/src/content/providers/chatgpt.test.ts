import { describe, expect, it } from 'vitest';
import { ChatGPTParser } from './chatgpt.js';

const parser = new ChatGPTParser();

// Convenience: factor of 1000 between unix-seconds (API) and ms (ChatMessage).
const SEC = 1000;

interface NodeOpts {
  parent?: string | null;
  children?: string[];
  role?: 'user' | 'assistant' | 'system' | 'tool';
  text?: string;
  createTime?: number | null;
  weight?: number;
  hidden?: boolean;
  recipient?: string;
  parts?: unknown[];
  contentType?: string;
}

function node(id: string, o: NodeOpts = {}): Record<string, unknown> {
  if (o.role === undefined) {
    return { id, message: null, parent: o.parent ?? null, children: o.children ?? [] };
  }
  return {
    id,
    message: {
      id,
      author: { role: o.role, name: null, metadata: {} },
      create_time: o.createTime ?? null,
      content: { content_type: o.contentType ?? 'text', parts: o.parts ?? [o.text ?? ''] },
      status: 'finished_successfully',
      end_turn: true,
      weight: o.weight ?? 1.0,
      metadata: o.hidden ? { is_visually_hidden_from_conversation: true } : {},
      recipient: o.recipient ?? 'all',
    },
    parent: o.parent ?? null,
    children: o.children ?? [],
  };
}

describe('ChatGPTParser.parseConversation', () => {
  it('returns null on garbage / non-conversation bodies', () => {
    expect(parser.parseConversation(null, '', '')).toBeNull();
    expect(parser.parseConversation({}, '', '')).toBeNull();
    expect(parser.parseConversation({ mapping: {} }, '', '')).toBeNull();
    expect(parser.parseConversation({ current_node: 'x' }, '', '')).toBeNull();
  });

  it('linearises a simple user → assistant → user → assistant chain', () => {
    const body = {
      title: 'Hello',
      current_node: 'a4',
      mapping: {
        root: node('root', { children: ['a1'] }),
        a1: node('a1', {
          parent: 'root',
          role: 'system',
          text: '',
          weight: 0,
          hidden: true,
          createTime: null,
          children: ['a2'],
        }),
        a2: node('a2', {
          parent: 'a1',
          role: 'user',
          text: 'hi',
          createTime: 1714000000,
          children: ['a3'],
        }),
        a3: node('a3', {
          parent: 'a2',
          role: 'assistant',
          text: 'hello!',
          createTime: 1714000005,
          children: ['a4'],
        }),
        a4: node('a4', {
          parent: 'a3',
          role: 'user',
          text: 'how are you?',
          createTime: 1714000020,
          children: [],
        }),
      },
    };
    const conv = parser.parseConversation(body, 'https://chatgpt.com/c/abc', '')!;
    expect(conv.title).toBe('Hello');
    expect(conv.url).toBe('https://chatgpt.com/c/abc');
    expect(conv.messages).toEqual([
      { id: 'a2', role: 'user', content: 'hi', createdAt: 1714000000 * SEC },
      { id: 'a3', role: 'assistant', content: 'hello!', createdAt: 1714000005 * SEC },
      { id: 'a4', role: 'user', content: 'how are you?', createdAt: 1714000020 * SEC },
    ]);
  });

  it('drops hidden / weight=0 / system / tool / non-all recipient nodes', () => {
    const body = {
      title: 'Mixed',
      current_node: 'leaf',
      mapping: {
        root: node('root', { children: ['s1'] }),
        s1: node('s1', { parent: 'root', role: 'system', hidden: true, children: ['u1'] }),
        u1: node('u1', {
          parent: 's1',
          role: 'user',
          text: 'real prompt',
          createTime: 1714000000,
          children: ['t1'],
        }),
        t1: node('t1', {
          parent: 'u1',
          role: 'assistant',
          recipient: 'browser.search', // internal handoff
          text: 'search query',
          createTime: 1714000001,
          children: ['t2'],
        }),
        t2: node('t2', {
          parent: 't1',
          role: 'tool',
          text: 'search results blob',
          createTime: 1714000002,
          children: ['leaf'],
        }),
        leaf: node('leaf', {
          parent: 't2',
          role: 'assistant',
          text: 'final answer',
          createTime: 1714000005,
          children: [],
        }),
      },
    };
    const conv = parser.parseConversation(body, 'u', 'fb')!;
    expect(conv.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:real prompt',
      'assistant:final answer',
    ]);
  });

  it('falls back to fallbackTitle when API title is null/empty/whitespace', () => {
    const body = {
      title: null,
      current_node: 'leaf',
      mapping: {
        leaf: node('leaf', { role: 'user', text: 'x', createTime: 1, children: [] }),
      },
    };
    expect(parser.parseConversation(body, 'u', 'doc-title')!.title).toBe('doc-title');
    expect(parser.parseConversation({ ...body, title: '   ' }, 'u', 'doc-title')!.title).toBe(
      'doc-title',
    );
    expect(parser.parseConversation({ ...body, title: '' }, 'u', '')!.title).toBe('Untitled');
  });

  it('handles multimodal_text by emitting [image] / [content_type] for non-string parts', () => {
    const body = {
      title: 't',
      current_node: 'leaf',
      mapping: {
        leaf: node('leaf', {
          role: 'user',
          contentType: 'multimodal_text',
          parts: [
            'caption text',
            { content_type: 'image_asset_pointer', asset_pointer: 'file-123' },
            { content_type: 'audio_transcription' },
          ],
          createTime: 1714000000,
          children: [],
        }),
      },
    };
    const conv = parser.parseConversation(body, 'u', '')!;
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.content).toBe(
      ['caption text', '[image]', '[audio_transcription]'].join('\n\n'),
    );
  });

  it('skips empty messages (no usable parts after filtering)', () => {
    const body = {
      title: 't',
      current_node: 'leaf',
      mapping: {
        u1: node('u1', {
          role: 'user',
          parts: ['', '   ', '\n'],
          createTime: 1,
          children: ['leaf'],
        }),
        leaf: node('leaf', {
          parent: 'u1',
          role: 'assistant',
          text: 'a',
          createTime: 2,
          children: [],
        }),
      },
    };
    const conv = parser.parseConversation(body, 'u', '')!;
    expect(conv.messages.map((m) => m.id)).toEqual(['leaf']);
  });

  it('walks via current_node — non-active branches are NOT included', () => {
    // Tree:
    //   u1 -> a-old (older regen)   ← out of active branch
    //      \-> a-new -> u2 -> leaf  ← current_node = leaf
    const body = {
      title: 't',
      current_node: 'leaf',
      mapping: {
        u1: node('u1', {
          role: 'user',
          text: 'q',
          createTime: 1,
          children: ['a-old', 'a-new'],
        }),
        'a-old': node('a-old', { parent: 'u1', role: 'assistant', text: 'OLD', createTime: 2 }),
        'a-new': node('a-new', {
          parent: 'u1',
          role: 'assistant',
          text: 'NEW',
          createTime: 3,
          children: ['u2'],
        }),
        u2: node('u2', {
          parent: 'a-new',
          role: 'user',
          text: 'follow-up',
          createTime: 4,
          children: ['leaf'],
        }),
        leaf: node('leaf', {
          parent: 'u2',
          role: 'assistant',
          text: 'reply',
          createTime: 5,
          children: [],
        }),
      },
    };
    const conv = parser.parseConversation(body, 'u', '')!;
    expect(conv.messages.map((m) => m.content)).toEqual(['q', 'NEW', 'follow-up', 'reply']);
  });

  it('returns null when current_node is missing or unknown', () => {
    expect(
      parser.parseConversation({ mapping: { x: node('x') }, current_node: null }, 'u', ''),
    ).toBeNull();
    // current_node references an id not in mapping → walks zero nodes,
    // produces an empty messages list (still a valid conversation, just empty).
    const empty = parser.parseConversation(
      { mapping: { x: node('x') }, current_node: 'does-not-exist' },
      'u',
      'fb',
    );
    expect(empty?.messages).toEqual([]);
  });

  it('caps title at 200 chars to match sanitizeFilename', () => {
    const long = 'x'.repeat(500);
    const body = {
      title: long,
      current_node: 'leaf',
      mapping: { leaf: node('leaf', { role: 'user', text: 'q', createTime: 1, children: [] }) },
    };
    const conv = parser.parseConversation(body, 'u', '')!;
    expect(conv.title.length).toBe(200);
  });
});
