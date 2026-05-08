// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  collectActivityByDate,
  collectTodayPrompts,
  extractPromptFromItem,
  findTodayHeader,
  isDateHeader,
  parseDateHeader,
} from './scraper.js';

function makeRoot(html: string): HTMLElement {
  // We attach to document.body so jsdom honours layout/visibility heuristics
  // for innerText (otherwise innerText collapses surprisingly).
  document.body.innerHTML = html;
  return document.body;
}

describe('isDateHeader', () => {
  it('matches Chinese and English Today/Yesterday', () => {
    expect(isDateHeader('今天')).toBe(true);
    expect(isDateHeader('昨天')).toBe(true);
    expect(isDateHeader('Today')).toBe(true);
    expect(isDateHeader('Yesterday')).toBe(true);
  });

  it('matches Chinese month/day forms', () => {
    expect(isDateHeader('6月25日')).toBe(true);
    expect(isDateHeader('12月1日')).toBe(true);
    expect(isDateHeader('2024年12月1日')).toBe(true);
  });

  it('matches numeric M/D form', () => {
    expect(isDateHeader('6/25')).toBe(true);
    expect(isDateHeader('12/1')).toBe(true);
  });

  it('rejects unrelated strings and empty input', () => {
    expect(isDateHeader('hello')).toBe(false);
    expect(isDateHeader('提示 query')).toBe(false);
    expect(isDateHeader('')).toBe(false);
    expect(isDateHeader(null)).toBe(false);
    expect(isDateHeader(undefined)).toBe(false);
  });
});

describe('extractPromptFromItem', () => {
  const make = (html: string): Element => {
    const root = makeRoot(html);
    return root.firstElementChild!;
  };

  it('extracts after the Chinese 提示 prefix (space variant)', () => {
    // Use \n directly — jsdom's innerText doesn't insert newlines at <br>,
    // though real browsers do. The production parser splits on \n.
    const el = make('<div>10:20\n提示 你好世界</div>');
    expect(extractPromptFromItem(el)).toBe('你好世界');
  });

  it('extracts after the Chinese 提示： prefix (colon variant)', () => {
    const el = make('<div>10:20\n提示：你好世界</div>');
    expect(extractPromptFromItem(el)).toBe('你好世界');
  });

  it('extracts after the English Prompt prefix', () => {
    const el = make('<div>10:20\nPrompt hello world</div>');
    expect(extractPromptFromItem(el)).toBe('hello world');
  });

  it('extracts after the English "Prompt: " prefix', () => {
    const el = make('<div>10:20\nPrompt: hello world</div>');
    expect(extractPromptFromItem(el)).toBe('hello world');
  });

  it('returns null when no prompt line is present', () => {
    const el = make('<div>some other content with no prefix</div>');
    expect(extractPromptFromItem(el)).toBe(null);
  });
});

describe('findTodayHeader', () => {
  it('locates the today div whose next c-wiz sibling exists', () => {
    makeRoot(`
      <div id="today">今天</div>
      <c-wiz id="item-1"><div>提示 你好</div></c-wiz>
      <c-wiz id="item-2"><div>提示 再见</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 旧</div></c-wiz>
    `);
    const header = findTodayHeader(document);
    expect(header?.id).toBe('today');
  });

  it('returns null when "今天" has no items beneath it (next sibling is another date)', () => {
    makeRoot(`
      <div>今天</div>
      <div>昨天</div>
      <c-wiz><div>提示 yesterday item</div></c-wiz>
    `);
    expect(findTodayHeader(document)).toBe(null);
  });

  it('returns null when no today header is present at all', () => {
    makeRoot('<div>昨天</div><c-wiz><div>提示 foo</div></c-wiz>');
    expect(findTodayHeader(document)).toBe(null);
  });

  it('skips decorative siblings between the header and the first c-wiz', () => {
    makeRoot(`
      <div id="today">今天</div>
      <div class="spacer">tip text not a date</div>
      <c-wiz><div>提示 hello</div></c-wiz>
    `);
    const header = findTodayHeader(document);
    expect(header?.id).toBe('today');
  });
});

describe('collectTodayPrompts', () => {
  it('collects all prompts under the Today header in DOM order', () => {
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>10:20\n提示 第一条</div></c-wiz>
      <c-wiz><div>10:25\n提示 第二条</div></c-wiz>
      <c-wiz><div>10:30\n提示 第三条</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 不要包含</div></c-wiz>
    `);
    const prompts = collectTodayPrompts(document);
    expect(prompts).toEqual(['第一条', '第二条', '第三条']);
  });

  it('returns [] when there is no today header', () => {
    makeRoot('<div>昨天</div><c-wiz><div>提示 旧</div></c-wiz>');
    expect(collectTodayPrompts(document)).toEqual([]);
  });

  it('skips c-wiz items whose body has no recognizable prompt prefix', () => {
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>10:20\n提示 keepme</div></c-wiz>
      <c-wiz><div>some other event with no prefix</div></c-wiz>
    `);
    expect(collectTodayPrompts(document)).toEqual(['keepme']);
  });

  it('stops at the next date header (e.g. 昨天)', () => {
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>提示 today-1</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 yesterday-1</div></c-wiz>
      <div>6月25日</div>
      <c-wiz><div>提示 older</div></c-wiz>
    `);
    expect(collectTodayPrompts(document)).toEqual(['today-1']);
  });

  it('handles English locale (Today / Prompt)', () => {
    makeRoot(`
      <div>Today</div>
      <c-wiz><div>10:20\nPrompt hello world</div></c-wiz>
      <c-wiz><div>10:25\nPrompt: bye</div></c-wiz>
      <div>Yesterday</div>
      <c-wiz><div>Prompt old</div></c-wiz>
    `);
    expect(collectTodayPrompts(document)).toEqual(['hello world', 'bye']);
  });
});

describe('parseDateHeader', () => {
  // Pin "now" so year-wrap logic is deterministic.
  const NOW = new Date(2026, 4, 6); // 2026-05-06 local

  it('resolves 今天 / Today to today', () => {
    expect(parseDateHeader('今天', NOW)).toBe('2026-05-06');
    expect(parseDateHeader('Today', NOW)).toBe('2026-05-06');
    expect(parseDateHeader('今日', NOW)).toBe('2026-05-06');
  });

  it('resolves 昨天 / Yesterday to yesterday', () => {
    expect(parseDateHeader('昨天', NOW)).toBe('2026-05-05');
    expect(parseDateHeader('Yesterday', NOW)).toBe('2026-05-05');
  });

  it('parses Chinese full-date "YYYY年M月D日"', () => {
    expect(parseDateHeader('2024年12月25日', NOW)).toBe('2024-12-25');
    expect(parseDateHeader('2025年1月1日', NOW)).toBe('2025-01-01');
  });

  it('parses Chinese "M月D日" with year-wrap (most-recent <= today)', () => {
    // April → April 2026 (earlier this year)
    expect(parseDateHeader('4月15日', NOW)).toBe('2026-04-15');
    // December → December 2025 (would be in the future this year)
    expect(parseDateHeader('12月25日', NOW)).toBe('2025-12-25');
  });

  it('parses numeric "M/D/YYYY" and "M/D/YY"', () => {
    expect(parseDateHeader('1/15/2024', NOW)).toBe('2024-01-15');
    expect(parseDateHeader('12/25/24', NOW)).toBe('2024-12-25');
  });

  it('parses numeric "M/D" with year-wrap', () => {
    expect(parseDateHeader('4/15', NOW)).toBe('2026-04-15');
    expect(parseDateHeader('12/25', NOW)).toBe('2025-12-25');
  });

  it('returns null for unrecognised labels', () => {
    expect(parseDateHeader('hello', NOW)).toBe(null);
    expect(parseDateHeader('', NOW)).toBe(null);
    expect(parseDateHeader('   ', NOW)).toBe(null);
    expect(parseDateHeader(null, NOW)).toBe(null);
    expect(parseDateHeader(undefined, NOW)).toBe(null);
  });
});

describe('collectActivityByDate', () => {
  const NOW = new Date(2026, 4, 6); // 2026-05-06

  it('walks all date sections and bins prompts by date', () => {
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>10:20\n提示 today-1</div></c-wiz>
      <c-wiz><div>10:25\n提示 today-2</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 yesterday-1</div></c-wiz>
      <div>4月29日</div>
      <c-wiz><div>提示 last-week</div></c-wiz>
      <c-wiz><div>提示 last-week-2</div></c-wiz>
    `);
    const idx = collectActivityByDate(document, NOW);
    expect(idx.days).toEqual([
      { date: '2026-05-06', prompts: ['today-1', 'today-2'] },
      { date: '2026-05-05', prompts: ['yesterday-1'] },
      { date: '2026-04-29', prompts: ['last-week', 'last-week-2'] },
    ]);
    // Local wall-clock ISO with explicit offset; whatever the test runner's
    // TZ is, it must match the YYYY-MM-DDTHH:MM:SS shape and end with a
    // signed HH:MM offset. (We can't compare to a fixed string because
    // CI may run in a different TZ than UTC+8.)
    expect(idx.scrapedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });

  it('treats only recognised date-headers as section boundaries', () => {
    // An unrecognised div BETWEEN two date sections doesn't introduce its
    // own bucket; the items after it roll into the preceding section
    // (today). Better to over-include than to silently drop data when
    // myactivity ships a new header format we don't recognise yet.
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>提示 today-1</div></c-wiz>
      <div>未识别的标题</div>
      <c-wiz><div>提示 today-orphan</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 yesterday-1</div></c-wiz>
    `);
    const idx = collectActivityByDate(document, NOW);
    expect(idx.days).toEqual([
      { date: '2026-05-06', prompts: ['today-1', 'today-orphan'] },
      { date: '2026-05-05', prompts: ['yesterday-1'] },
    ]);
  });

  it('omits days that have a header but zero recognisable prompt items', () => {
    makeRoot(`
      <div>今天</div>
      <c-wiz><div>some banner with no prefix</div></c-wiz>
      <div>昨天</div>
      <c-wiz><div>提示 yesterday-1</div></c-wiz>
    `);
    const idx = collectActivityByDate(document, NOW);
    expect(idx.days).toEqual([{ date: '2026-05-05', prompts: ['yesterday-1'] }]);
  });

  it('handles English locale across multiple days', () => {
    makeRoot(`
      <div>Today</div>
      <c-wiz><div>Prompt hello</div></c-wiz>
      <div>Yesterday</div>
      <c-wiz><div>Prompt: world</div></c-wiz>
      <div>4/29</div>
      <c-wiz><div>Prompt last week</div></c-wiz>
    `);
    const idx = collectActivityByDate(document, NOW);
    expect(idx.days).toEqual([
      { date: '2026-05-06', prompts: ['hello'] },
      { date: '2026-05-05', prompts: ['world'] },
      { date: '2026-04-29', prompts: ['last week'] },
    ]);
  });
});
