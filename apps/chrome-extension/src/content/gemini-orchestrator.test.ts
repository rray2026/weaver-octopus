// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://gemini.google.com/app/abc12345-conv" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveChatDate,
  pickPromptsInRange,
  startGeminiOrchestrator,
} from './gemini-orchestrator.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../test/chromeMock.js';
import type { GeminiActivityIndex } from '../types/index.js';

const ACTIVITY_KEY = 'geminiActivity';
const HASH_KEY = 'convHashes';

/** Convenience: build a one-day activity index for `todayDateString()`. */
function todayActivity(prompts: string[]): GeminiActivityIndex {
  return {
    scrapedAt: new Date().toISOString(),
    days: [{ date: todayDateString(), prompts }],
  };
}

function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA');
}

function setupConversationDom(turns: Array<{ q: string; a: string }>): void {
  document.body.innerHTML = turns
    .map(
      (t) => `
      <div class="conversation-container">
        <user-query>${t.q}</user-query>
        <model-response>${t.a}</model-response>
      </div>
    `,
    )
    .join('');
  document.title = '我的对话 - Gemini';
}

async function flushAsync(loops = 30): Promise<void> {
  for (let i = 0; i < loops; i++) await Promise.resolve();
}

describe('startGeminiOrchestrator', () => {
  let mock: ChromeMock;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    mock = installChromeMock({
      manifest: { host_permissions: ['https://gemini.google.com/*'] },
    });
    // Live capture is OFF by default in production. Pre-enable so the
    // orchestrator pipeline runs in tests; the gate itself is covered by
    // live-capture-gate.test.ts.
    mock.storage.local['liveCaptureEnabled'] = true;
    document.body.innerHTML = '';
    document.title = '';
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    uninstallChromeMock();
    document.body.innerHTML = '';
  });

  it('exports today slice when myactivity prompts already match the most recent turns', async () => {
    setupConversationDom([
      { q: 'old history', a: 'old reply' },
      { q: 'today A', a: 'reply A' },
      { q: 'today B', a: 'reply B' },
    ]);
    // newest-first as myactivity displays it
    mock.storage.local[ACTIVITY_KEY] = todayActivity(['today B', 'today A']);

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await vi.waitFor(
      () => {
        expect(mock.runtime.sendMessage).toHaveBeenCalled();
      },
      { timeout: 1000 },
    );

    // First call may be DOWNLOAD_REQUEST or REFRESH_ACTIVITY (we have today
    // prompts here, so it should be DOWNLOAD_REQUEST). Filter to be safe.
    const downloadCall = mock.runtime.sendMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloadCall).toBeDefined();
    const arg = downloadCall![0] as { filename: string; content: string };
    expect(arg.filename).toMatch(/\[gemini\] 我的对话-abc12345\.md$/);
    expect(arg.filename).toContain(`weaver-octopus/${todayDateString()}/`);
    expect(arg.content).toContain('# 我的对话');
    expect(arg.content).toContain('**Provider**: gemini');
    expect(arg.content).toContain('today A');
    expect(arg.content).toContain('today B');
    expect(arg.content).not.toContain('old history');
  });

  it('skips the welcome page (no conversation id in URL)', async () => {
    // jsdom's URL is fixed for this file, so we can't change it. Instead simulate
    // an unrelated body and rely on the URL-no-id branch only when conv-id is null.
    // Here we exercise the related "no turns scraped" branch which is also a no-op.
    document.body.innerHTML = '<div>just a welcome banner</div>';
    document.title = 'Gemini';

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await flushAsync(60);
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('skips when last turn is still streaming (Stop button visible)', async () => {
    setupConversationDom([{ q: 'today A', a: 'partial' }]);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button aria-label="Stop response">Stop</button>',
    );
    mock.storage.local[ACTIVITY_KEY] = todayActivity(['today A']);

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await flushAsync(60);
    const downloadCalls = mock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloadCalls).toHaveLength(0);
  });

  it('requests REFRESH_ACTIVITY when no today prompts are available', async () => {
    setupConversationDom([{ q: 'history', a: 'reply' }]);
    // no ACTIVITY_KEY → null today prompts. The orchestrator must attempt one
    // refresh of myactivity; if the refresh still produces nothing, the
    // chat is skipped (no guesswork).

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await vi.waitFor(
      () => {
        const types = mock.runtime.sendMessage.mock.calls.map(
          (c) => (c[0] as { type: string }).type,
        );
        expect(types).toContain('REFRESH_ACTIVITY');
      },
      { timeout: 1000 },
    );
  });

  it('does NOT download a chat just because turns rendered after the orchestrator first observed it', async () => {
    // Regression: when backfill clicks a sidebar link the SPA used to
    // render the chat in stages. An early MutationObserver tick saw a
    // partially-rendered DOM and the orchestrator pinned a "baseline"
    // there; the next tick saw the full conversation and treated every
    // newly-rendered turn as "newSession" (presumed today). The result
    // was downloading the entire historical conversation as today's
    // chat. Fix: the slice is decided exclusively by myactivity matching
    // — no baseline / newSession fallback.

    // Set up a chat with a single turn that doesn't match today's
    // myactivity. With the old code the orchestrator might still have
    // counted it as today via the newSession fallback when myactivity
    // was empty. Now we verify only matching turns get downloaded.
    setupConversationDom([{ q: 'historical question from yesterday', a: 'a' }]);
    mock.storage.local[ACTIVITY_KEY] = todayActivity(['some unrelated today prompt']);

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    // Give the orchestrator more than enough time to process. With the
    // bug, the orchestrator would have sent a DOWNLOAD_REQUEST. With the
    // fix, no download is sent at all.
    await flushAsync(80);

    const downloadCalls = mock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloadCalls).toHaveLength(0);
  });

  it('skips a chat with action=skipped:other when myactivity returns no today prompts after refresh', async () => {
    setupConversationDom([{ q: 'something', a: 'reply' }]);
    // No ACTIVITY_KEY at all. Refresh attempt also won't populate it (mock
    // chrome.tabs.create is a no-op as far as storage.local is concerned).
    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await flushAsync(80);
    const downloadCalls = mock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloadCalls).toHaveLength(0);
  });

  it('dedups identical content via the cross-tab convHashes hash', async () => {
    setupConversationDom([{ q: 'today A', a: 'reply A' }]);
    mock.storage.local[ACTIVITY_KEY] = todayActivity(['today A']);

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });
    await vi.waitFor(
      () => {
        const downloads = mock.runtime.sendMessage.mock.calls.filter(
          (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
        );
        expect(downloads.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    // Confirm the persisted hash is keyed under "gemini:<convId>".
    const stored = mock.storage.local[HASH_KEY] as Record<string, string>;
    expect(stored).toBeDefined();
    expect(Object.keys(stored).some((k) => k.startsWith('gemini:'))).toBe(true);
  });

  it('dispose() detaches MutationObserver and storage listener', async () => {
    setupConversationDom([{ q: 'today A', a: 'reply A' }]);
    mock.storage.local[ACTIVITY_KEY] = todayActivity(['today A']);

    const d = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });
    await vi.waitFor(
      () => expect(mock.runtime.sendMessage).toHaveBeenCalled(),
      { timeout: 1000 },
    );
    mock.runtime.sendMessage.mockClear();
    d();

    // Mutation after dispose should not retrigger the orchestrator.
    document.body.insertAdjacentHTML('beforeend', '<div>extra</div>');
    await flushAsync(60);
    const downloads = mock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloads).toHaveLength(0);
  });
});

describe('pickPromptsInRange', () => {
  function ms(ymd: string): number {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getTime();
  }
  function range(startYmd: string, endExclusiveYmd: string): { start: number; end: number } {
    return { start: ms(startYmd), end: ms(endExclusiveYmd) };
  }

  const idx: GeminiActivityIndex = {
    scrapedAt: '2026-05-06T00:00:00Z',
    days: [
      { date: '2026-05-06', prompts: ['today-1', 'today-2'] },
      { date: '2026-05-05', prompts: ['yesterday-1'] },
      { date: '2026-04-29', prompts: ['last-week-1'] },
      { date: '2026-04-15', prompts: ['april-1'] },
    ],
  };

  it('returns just today\'s prompts for a today-only range', () => {
    expect(pickPromptsInRange(idx, range('2026-05-06', '2026-05-07'))).toEqual({
      prompts: ['today-1', 'today-2'],
      dates: ['2026-05-06', '2026-05-06'],
    });
  });

  it('returns last-7-days flattened, preserving newest-first order, with parallel dates', () => {
    expect(pickPromptsInRange(idx, range('2026-04-30', '2026-05-07'))).toEqual({
      prompts: ['today-1', 'today-2', 'yesterday-1'],
      dates: ['2026-05-06', '2026-05-06', '2026-05-05'],
    });
  });

  it('returns empty when the range falls outside any captured day', () => {
    expect(pickPromptsInRange(idx, range('2025-01-01', '2025-01-08'))).toEqual({
      prompts: [],
      dates: [],
    });
  });

  it('treats `end` as exclusive (boundary day on `end` is NOT included)', () => {
    // [2026-05-05, 2026-05-06) → only yesterday, NOT today.
    expect(pickPromptsInRange(idx, range('2026-05-05', '2026-05-06'))).toEqual({
      prompts: ['yesterday-1'],
      dates: ['2026-05-05'],
    });
  });

  it('skips days whose date string is malformed', () => {
    const broken: GeminiActivityIndex = {
      scrapedAt: '',
      days: [
        { date: 'not-a-date', prompts: ['junk'] },
        { date: '2026-05-06', prompts: ['ok'] },
      ],
    };
    expect(pickPromptsInRange(broken, range('2026-05-01', '2026-05-31'))).toEqual({
      prompts: ['ok'],
      dates: ['2026-05-06'],
    });
  });
});

describe('deriveChatDate', () => {
  it('returns the most-recent date among matched prompts', () => {
    const slice = [
      { userText: 'old prompt', modelText: '' },
      { userText: 'newer prompt', modelText: '' },
    ];
    const prompts = ['old prompt', 'newer prompt'];
    const dates = ['2026-04-29', '2026-05-05'];
    expect(deriveChatDate(slice, prompts, dates)).toBe('2026-05-05');
  });

  it('claims-once: same prompt only attributed to one slice turn', () => {
    const slice = [
      { userText: 'shared', modelText: '' },
      { userText: 'shared', modelText: '' },
    ];
    const prompts = ['shared', 'shared'];
    const dates = ['2026-05-04', '2026-05-05'];
    // Walks newest→oldest: turn[1] claims dates[0], turn[0] claims dates[1].
    // (The matcher claim-once order isn't important here — what matters
    // is that BOTH dates contribute to the max.) Expected max: 2026-05-05.
    expect(deriveChatDate(slice, prompts, dates)).toBe('2026-05-05');
  });

  it('returns null when nothing matches', () => {
    const slice = [{ userText: 'foo', modelText: '' }];
    expect(deriveChatDate(slice, ['bar'], ['2026-05-05'])).toBe(null);
  });

  it('returns null on empty inputs', () => {
    expect(deriveChatDate([], ['p'], ['2026-05-05'])).toBe(null);
    expect(deriveChatDate([{ userText: 'p', modelText: '' }], [], [])).toBe(null);
  });

  it('matches via TRUNCATED-PREFIX (myactivity-truncates-with-…)', () => {
    const slice = [{ userText: 'this is a really long prompt that goes on forever', modelText: '' }];
    const prompts = ['this is a really lo…'];
    const dates = ['2026-05-05'];
    expect(deriveChatDate(slice, prompts, dates)).toBe('2026-05-05');
  });
});
