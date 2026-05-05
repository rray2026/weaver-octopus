// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  computeTodaySlice,
  findMatchIndexAfter,
  getConversationIdFromUrl,
  isLastTurnIncomplete,
  scrapeTurns,
  sliceFingerprint,
  traceSliceMismatch,
  type GeminiTurn,
} from './gemini.js';

function makeRoot(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('getConversationIdFromUrl', () => {
  it('extracts the id from /app/<id>', () => {
    expect(getConversationIdFromUrl('https://gemini.google.com/app/abc123def')).toBe('abc123def');
  });

  it('extracts the id from /u/0/app/<id>', () => {
    expect(getConversationIdFromUrl('https://gemini.google.com/u/0/app/xyz789')).toBe('xyz789');
  });

  it('strips trailing query strings and fragments', () => {
    expect(
      getConversationIdFromUrl('https://gemini.google.com/app/abc?foo=1#bar'),
    ).toBe('abc');
  });

  it('returns null on the welcome page (no id)', () => {
    expect(getConversationIdFromUrl('https://gemini.google.com/app')).toBe(null);
    expect(getConversationIdFromUrl('https://gemini.google.com/')).toBe(null);
  });

  it('returns null for malformed URLs', () => {
    expect(getConversationIdFromUrl('not a url')).toBe(null);
  });
});

describe('cleanTitle', () => {
  it('removes the "- Gemini" suffix', () => {
    expect(cleanTitle('我的对话 - Gemini')).toBe('我的对话');
  });

  it('handles em-dash and en-dash separators', () => {
    expect(cleanTitle('Hello — Gemini Apps')).toBe('Hello');
    expect(cleanTitle('Hello – Gemini')).toBe('Hello');
  });

  it('returns empty for empty input', () => {
    expect(cleanTitle('')).toBe('');
  });

  it('leaves titles without the suffix unchanged', () => {
    expect(cleanTitle('A standalone title')).toBe('A standalone title');
  });
});

describe('findMatchIndexAfter', () => {
  it('returns -1 when prompt is empty', () => {
    expect(findMatchIndexAfter('', ['a'], -1)).toBe(-1);
  });

  it('matches an exact prompt', () => {
    expect(findMatchIndexAfter('hello world', ['hello world', 'foo'], -1)).toBe(0);
  });

  it('matches when myactivity truncated the prompt with an ellipsis', () => {
    // myactivity entry "tell me about…" should match the full prompt.
    expect(findMatchIndexAfter('tell me about quantum', ['tell me about…'], -1)).toBe(0);
  });

  it('does NOT match when chat prompt is a substring of an un-truncated activity entry', () => {
    // Earlier looser behaviour treated this as a match — but the prompts are
    // genuinely different; the user typed "quantum" today, but the activity
    // entry is some other (longer) prompt that happens to contain "quantum".
    expect(findMatchIndexAfter('quantum', ['tell me about quantum mechanics'], -1)).toBe(-1);
  });

  it('does NOT match a short generic prompt against a long similar activity entry', () => {
    // Regression: "hi" used to match anything starting with "hi" (e.g.
    // yesterday's "hi I have a question..."), pulling pre-today turns into
    // the slice. With strict matching this no longer fires.
    expect(findMatchIndexAfter('hi', ['hi I have a question'], -1)).toBe(-1);
  });

  it('still matches when the truncated activity prefix is substantial (≥ 8 chars)', () => {
    expect(findMatchIndexAfter('explain transformers in detail', ['explain transformers…'], -1))
      .toBe(0);
  });

  it('does NOT match when the truncated activity prefix is short (avoids false positives)', () => {
    // "hi…" → 'hi' is only 2 chars normalised. Refuse to claim a match.
    expect(findMatchIndexAfter('hi I have a question', ['hi…'], -1)).toBe(-1);
  });

  it('matches across mismatched trailing punctuation (?, !, .)', () => {
    // Chat as typed by the user: "请帮我写代码？"
    // myactivity stored: "请帮我写代码"
    expect(findMatchIndexAfter('请帮我写代码？', ['请帮我写代码'], -1)).toBe(0);
    expect(findMatchIndexAfter('hello!', ['hello'], -1)).toBe(0);
    expect(findMatchIndexAfter('done.', ['done'], -1)).toBe(0);
  });

  it('matches across multiple trailing punctuation runs (??!)', () => {
    expect(findMatchIndexAfter('really??!', ['really'], -1)).toBe(0);
  });

  it('matches across CJK + ASCII trailing punctuation mix', () => {
    expect(findMatchIndexAfter('好的，', ['好的。'], -1)).toBe(0);
  });

  it('strips Gemini accessibility/TTS prefix "你说" before comparing', () => {
    // Gemini's chat DOM prepends "你说" (literally "you said") to the
    // user-query for screen-reader rendering. myactivity has just the
    // underlying prompt — we must strip the prefix so they strict-match.
    expect(findMatchIndexAfter('你说推荐今天夜晚的餐馆', ['推荐今天夜晚的餐馆'], -1)).toBe(0);
  });

  it('also handles "您说" (formal) and traditional 說', () => {
    expect(findMatchIndexAfter('您说请帮我写代码', ['请帮我写代码'], -1)).toBe(0);
    expect(findMatchIndexAfter('你說推薦餐廳', ['推薦餐廳'], -1)).toBe(0);
  });

  it('handles English equivalents "You said" / "User said"', () => {
    expect(findMatchIndexAfter('You said hello world', ['hello world'], -1)).toBe(0);
    expect(findMatchIndexAfter('User said: tell me a joke', ['tell me a joke'], -1)).toBe(0);
  });

  it('handles colon / full-width colon between prefix and prompt', () => {
    expect(findMatchIndexAfter('你说：推荐餐馆', ['推荐餐馆'], -1)).toBe(0);
    expect(findMatchIndexAfter('You said: anything', ['anything'], -1)).toBe(0);
  });

  it('does NOT strip when the prompt itself starts with the literal "你说"+more', () => {
    // Genuine prompt like "你说说看怎么办" should still match on both sides
    // (the strip removes "你说" once; trailing "说看怎么办" remains).
    // This test mainly documents that we accept a prompt of the form
    // "你说<rest>" by treating it as the prefix.
    expect(findMatchIndexAfter('你说说看怎么办', ['说看怎么办'], -1)).toBe(0);
  });

  it('respects the `after` exclusive lower bound', () => {
    // First match is at index 0 but `after` is 0 → must look at index 1+.
    expect(findMatchIndexAfter('hi', ['hi', 'hi', 'no'], 0)).toBe(1);
  });

  it('ignores whitespace and case differences', () => {
    expect(findMatchIndexAfter('HELLO  WORLD', ['hello world'], -1)).toBe(0);
  });

  it('returns -1 when no entry matches', () => {
    expect(findMatchIndexAfter('zzz', ['aaa', 'bbb'], -1)).toBe(-1);
  });
});

describe('computeTodaySlice', () => {
  const t = (userText: string, modelText = 'reply'): GeminiTurn => ({ userText, modelText });

  it('returns [] when myactivity has no prompts', () => {
    expect(computeTodaySlice([t('hi')], [])).toEqual([]);
  });

  it('returns the tail whose user prompts match myactivity in newest-first order', () => {
    const turns = [t('history-1'), t('history-2'), t('today-A'), t('today-B')];
    // myactivity newest-first: today-B is newest, then today-A.
    const result = computeTodaySlice(turns, ['today-B', 'today-A']);
    expect(result).toEqual([t('today-A'), t('today-B')]);
  });

  it('stops as soon as a turn fails to match (history not in today)', () => {
    const turns = [t('old'), t('today-A'), t('today-B')];
    const result = computeTodaySlice(turns, ['today-B', 'today-A']);
    expect(result).toEqual([t('today-A'), t('today-B')]);
  });

  it('returns [] when the most recent turn has no match in today', () => {
    const turns = [t('today-A'), t('not-in-today')];
    expect(computeTodaySlice(turns, ['today-A'])).toEqual([]);
  });

  it('does NOT reuse the same myactivity index for two different turns', () => {
    // If both turns matched activity[0], we'd incorrectly include both.
    // The strict-increasing minIdx forces only one consumption.
    const turns = [t('A'), t('A')];
    const result = computeTodaySlice(turns, ['A']);
    // Only the most recent turn matches; the earlier one can't reuse index 0.
    expect(result).toEqual([t('A')]);
  });

  it('handles the truncation case where myactivity has "..." suffix', () => {
    const turns = [t('explain transformers in detail with examples')];
    const result = computeTodaySlice(turns, ['explain transformers in detail…']);
    expect(result).toHaveLength(1);
  });

  it('stops on the first turn with empty userText', () => {
    const turns = [t(''), t('today-A')];
    const result = computeTodaySlice(turns, ['today-A']);
    expect(result).toEqual([t('today-A')]);
  });
});

describe('isLastTurnIncomplete', () => {
  it('returns false on empty turns array', () => {
    expect(isLastTurnIncomplete([])).toBe(false);
  });

  it('returns true when last turn has no model reply', () => {
    const root = makeRoot('');
    expect(isLastTurnIncomplete([{ userText: 'q', modelText: '' }], root)).toBe(true);
  });

  it('returns true when last model reply is suspiciously short (still streaming)', () => {
    expect(isLastTurnIncomplete([{ userText: 'q', modelText: 'hi' }], makeRoot(''))).toBe(true);
  });

  it('returns true when a Stop button is visible (model is generating)', () => {
    const root = makeRoot('<button aria-label="Stop response">Stop</button>');
    expect(
      isLastTurnIncomplete([{ userText: 'q', modelText: 'a long enough reply' }], root),
    ).toBe(true);
  });

  it('returns true when an aria-busy element exists', () => {
    const root = makeRoot('<div aria-busy="true">loading</div>');
    expect(
      isLastTurnIncomplete([{ userText: 'q', modelText: 'this looks complete' }], root),
    ).toBe(true);
  });

  it('returns false when last turn has a complete reply and nothing is busy', () => {
    const root = makeRoot('<div>idle ui</div>');
    expect(
      isLastTurnIncomplete([{ userText: 'q', modelText: 'this is a real reply' }], root),
    ).toBe(false);
  });

  it('returns false when the last turn has no userText (rendering edge case)', () => {
    expect(
      isLastTurnIncomplete([{ userText: '', modelText: '' }], makeRoot('')),
    ).toBe(false);
  });
});

describe('scrapeTurns', () => {
  it('reads turns from .conversation-container blocks', () => {
    const root = makeRoot(`
      <div class="conversation-container">
        <user-query>question 1</user-query>
        <model-response>answer 1</model-response>
      </div>
      <div class="conversation-container">
        <user-query>question 2</user-query>
        <model-response>answer 2</model-response>
      </div>
    `);
    const turns = scrapeTurns(root);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.userText).toBe('question 1');
    expect(turns[0]!.modelText).toBe('answer 1');
    expect(turns[1]!.userText).toBe('question 2');
    expect(turns[1]!.modelText).toBe('answer 2');
  });

  it('falls back to parallel selectors when no container is found', () => {
    const root = makeRoot(`
      <user-query>q1</user-query>
      <model-response>a1</model-response>
      <user-query>q2</user-query>
      <model-response>a2</model-response>
    `);
    const turns = scrapeTurns(root);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ userText: 'q1', modelText: 'a1' });
    expect(turns[1]).toEqual({ userText: 'q2', modelText: 'a2' });
  });

  it('handles a turn that is missing its model reply', () => {
    const root = makeRoot(`
      <div class="conversation-container">
        <user-query>only a question</user-query>
      </div>
    `);
    const turns = scrapeTurns(root);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('only a question');
    expect(turns[0]!.modelText).toBe('');
  });

  it('returns an empty array when there are no recognizable elements', () => {
    expect(scrapeTurns(makeRoot('<div>nothing here</div>'))).toEqual([]);
  });

  it('trims surrounding whitespace from extracted text', () => {
    const root = makeRoot(`
      <div class="conversation-container">
        <user-query>   padded q   </user-query>
        <model-response>   padded a   </model-response>
      </div>
    `);
    const turns = scrapeTurns(root);
    expect(turns[0]).toEqual({ userText: 'padded q', modelText: 'padded a' });
  });
});

describe('sliceFingerprint', () => {
  it('produces a stable key for identical slices', () => {
    const slice = [
      { userText: 'q', modelText: 'a' },
      { userText: 'qq', modelText: 'aa' },
    ];
    expect(sliceFingerprint(slice)).toBe(sliceFingerprint(slice));
  });

  it('changes when the last reply changes', () => {
    const a = [{ userText: 'q', modelText: 'first answer' }];
    const b = [{ userText: 'q', modelText: 'second answer' }];
    expect(sliceFingerprint(a)).not.toBe(sliceFingerprint(b));
  });

  it('changes when slice length changes', () => {
    const a = [{ userText: 'q', modelText: 'a' }];
    const b = [
      { userText: 'q', modelText: 'a' },
      { userText: 'q2', modelText: 'a2' },
    ];
    expect(sliceFingerprint(a)).not.toBe(sliceFingerprint(b));
  });
});

describe('traceSliceMismatch', () => {
  it('reports each turn vs each remaining myactivity entry, naming the verdict', () => {
    const lines: unknown[][] = [];
    const log = (...args: unknown[]) => lines.push(args);
    traceSliceMismatch(
      [
        { userText: 'history', modelText: 'r1' },
        { userText: 'today-A', modelText: 'r2' },
      ],
      ['today-A', 'today-B'],
      log,
    );
    const flat = lines.map((l) => l.join(' ')).join('\n');
    // Most-recent turn matches the first myactivity entry → labelled EQUAL.
    expect(flat).toMatch(/turn\[1\].*EQUAL/);
    // Earlier turn does not match anything → NO MATCH followed by stop.
    expect(flat).toMatch(/turn\[0\].*NO MATCH/);
    // Header listing both prompts must appear.
    expect(flat).toMatch(/myactivity\[0\] raw=/);
  });

  it('flags myactivity-empty as the cause when no today prompts exist', () => {
    const lines: string[] = [];
    traceSliceMismatch(
      [{ userText: 'q', modelText: 'a' }],
      [],
      (...args: unknown[]) => {
        lines.push(args.join(' '));
      },
    );
    expect(lines.some((l) => l.includes('myactivity returned no today prompts'))).toBe(true);
  });
});
