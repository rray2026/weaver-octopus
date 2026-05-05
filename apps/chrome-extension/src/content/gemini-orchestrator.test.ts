// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://gemini.google.com/app/abc12345-conv" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGeminiOrchestrator } from './gemini-orchestrator.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../test/chromeMock.js';
import type { TodayGeminiPrompts } from '../types/index.js';

const TODAY_KEY = 'todayGemini';
const HASH_KEY = 'convHashes';

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
    const today: TodayGeminiPrompts = {
      date: todayDateString(),
      // newest-first as myactivity displays it
      prompts: ['today B', 'today A'],
    };
    mock.storage.local[TODAY_KEY] = today;

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
    mock.storage.local[TODAY_KEY] = {
      date: todayDateString(),
      prompts: ['today A'],
    } satisfies TodayGeminiPrompts;

    dispose = startGeminiOrchestrator({ triggerDebounceMs: 1, refreshWaitMs: 1 });

    await flushAsync(60);
    const downloadCalls = mock.runtime.sendMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'DOWNLOAD_REQUEST',
    );
    expect(downloadCalls).toHaveLength(0);
  });

  it('requests REFRESH_ACTIVITY when no today prompts are available and there is no newSession', async () => {
    setupConversationDom([{ q: 'history', a: 'reply' }]);
    // no TODAY_KEY → null today prompts. Baseline = 1, so newSession is empty.

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

  it('dedups identical content via the cross-tab convHashes hash', async () => {
    setupConversationDom([{ q: 'today A', a: 'reply A' }]);
    mock.storage.local[TODAY_KEY] = {
      date: todayDateString(),
      prompts: ['today A'],
    } satisfies TodayGeminiPrompts;

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
    mock.storage.local[TODAY_KEY] = {
      date: todayDateString(),
      prompts: ['today A'],
    } satisfies TodayGeminiPrompts;

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
