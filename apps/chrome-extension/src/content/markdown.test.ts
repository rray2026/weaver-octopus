import { describe, expect, it } from 'vitest';
import { messagesToMarkdown, sanitizeFilename, todayDateString } from './markdown.js';
import type { ChatMessage } from '../types/index.js';

const msg = (role: 'user' | 'assistant', content: string, createdAt = 0): ChatMessage => ({
  id: `${role}-${createdAt}`,
  role,
  content,
  createdAt,
});

describe('sanitizeFilename', () => {
  it('replaces all illegal path characters with -', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('truncates to 200 chars', () => {
    const long = 'x'.repeat(500);
    expect(sanitizeFilename(long)).toHaveLength(200);
  });

  it('trims whitespace before truncating', () => {
    expect(sanitizeFilename('   hello   ')).toBe('hello');
  });

  it('falls back to "untitled" for empty input', () => {
    expect(sanitizeFilename('')).toBe('untitled');
  });

  it('falls back to "untitled" when only illegal chars and whitespace', () => {
    // only-illegal chars get replaced with dashes — the result has length, so it's NOT empty.
    // This documents current behavior: pure illegal-char input becomes a string of dashes.
    expect(sanitizeFilename('///')).toBe('---');
    // whitespace-only is trimmed to empty → fallback fires
    expect(sanitizeFilename('   ')).toBe('untitled');
  });

  it('leaves Unicode and brackets alone', () => {
    expect(sanitizeFilename('[claude] 你好 — chat')).toBe('[claude] 你好 — chat');
  });
});

describe('todayDateString', () => {
  it('returns YYYY-MM-DD form', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('messagesToMarkdown', () => {
  it('renders header + each message with role heading', () => {
    const md = messagesToMarkdown(
      [msg('user', 'hello'), msg('assistant', 'hi there')],
      'My Chat',
      'https://claude.ai/chat/abc',
    );
    expect(md).toContain('# My Chat');
    expect(md).toContain('**Provider**: claude');
    expect(md).toContain('**Captured**:');
    expect(md).toContain('**URL**: https://claude.ai/chat/abc');
    expect(md).toContain('## User\n\nhello');
    expect(md).toContain('## Assistant\n\nhi there');
  });

  it('omits Range line when rangeLabel is undefined', () => {
    const md = messagesToMarkdown([msg('user', 'q')], 'T', 'u');
    expect(md).not.toContain('**Range**');
  });

  it('includes Range line when rangeLabel is provided', () => {
    const md = messagesToMarkdown([msg('user', 'q')], 'T', 'u', '2026-04-27 → 2026-05-03');
    expect(md).toContain('**Range**: 2026-04-27 → 2026-05-03');
  });

  it('preserves message order from input array', () => {
    const md = messagesToMarkdown(
      [msg('user', 'first'), msg('assistant', 'second'), msg('user', 'third')],
      'T',
      'u',
    );
    const idxFirst = md.indexOf('first');
    const idxSecond = md.indexOf('second');
    const idxThird = md.indexOf('third');
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxThird).toBeGreaterThan(idxSecond);
  });

  it('trims whitespace inside each message body', () => {
    const md = messagesToMarkdown([msg('user', '   padded   ')], 'T', 'u');
    expect(md).toContain('## User\n\npadded\n');
    expect(md).not.toContain('   padded   ');
  });

  it('handles empty messages array (only header rendered)', () => {
    const md = messagesToMarkdown([], 'T', 'u');
    expect(md).toContain('# T');
    expect(md).not.toContain('## User');
    expect(md).not.toContain('## Assistant');
  });
});
