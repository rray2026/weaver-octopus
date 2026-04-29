// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOrchestrator } from './orchestrator.js';
import type { ConversationData, ProviderParser } from './providers/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../test/chromeMock.js';

const INTERCEPT_SOURCE = 'weaver-octopus:intercept';
const HASH_KEY = 'convHashes';

const CONV_A = '11111111-aaaa-bbbb-cccc-111111111111';
const CONV_B = '22222222-aaaa-bbbb-cccc-222222222222';

function makeConv(overrides: Partial<ConversationData> = {}): ConversationData {
  const now = Date.now();
  return {
    title: 'Test Chat',
    url: 'https://claude.ai/chat/abc',
    messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: now },
      { id: 'm2', role: 'assistant', content: 'hello', createdAt: now + 1 },
    ],
    ...overrides,
  };
}

function postFromMain(conversationId: string, body: unknown): void {
  // jsdom's window.postMessage sets event.origin to '' and event.source to a
  // proxy that isn't === window, so the orchestrator's guards reject it.
  // Dispatch a MessageEvent directly with the fields the production code expects.
  const ev = new MessageEvent('message', {
    data: { source: INTERCEPT_SOURCE, type: 'CONVERSATION', conversationId, body },
    origin: location.origin,
    source: window,
  });
  window.dispatchEvent(ev);
}

async function flushMacro(): Promise<void> {
  // dispatchEvent fires synchronously, but the orchestrator's handler does
  // async work (hydrate → load filter → hash → send). One macro tick + a
  // batch of microtasks lets that chain settle.
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('orchestrator', () => {
  let mockChrome: ChromeMock;
  let parser: ProviderParser;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    mockChrome = installChromeMock();
    parser = {
      parseConversation: vi.fn((body) => body as ConversationData | null),
    };
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    uninstallChromeMock();
  });

  it('downloads when a fresh conversation is intercepted', async () => {
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv());

    await vi.waitFor(() => {
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    const arg = mockChrome.runtime.sendMessage.mock.calls[0]![0];
    expect(arg.type).toBe('DOWNLOAD_REQUEST');
    expect(arg.filename).toMatch(/\[claude\] Test Chat-11111111\.md$/);
    expect(arg.content).toContain('# Test Chat');
    expect(arg.content).toContain('## User');
    expect(arg.content).toContain('## Assistant');
  });

  it('dedupes identical content per conversation', async () => {
    dispose = startOrchestrator(parser);
    const conv = makeConv();

    postFromMain(CONV_A, conv);
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));

    postFromMain(CONV_A, conv);
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('downloads different conversations independently', async () => {
    dispose = startOrchestrator(parser);

    postFromMain(CONV_A, makeConv({ title: 'Chat A' }));
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));

    postFromMain(CONV_B, makeConv({ title: 'Chat B' }));
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(2));

    const filenames = mockChrome.runtime.sendMessage.mock.calls.map((c) => c[0].filename);
    expect(filenames[0]).toContain('Chat A-11111111');
    expect(filenames[1]).toContain('Chat B-22222222');
  });

  it('skips download when range filter excludes all messages', async () => {
    dispose = startOrchestrator(parser);

    const yesterday = Date.now() - 1000 * 60 * 60 * 30;
    postFromMain(
      CONV_A,
      makeConv({
        messages: [{ id: 'old', role: 'user', content: 'old', createdAt: yesterday }],
      }),
    );

    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores messages from foreign origins', async () => {
    dispose = startOrchestrator(parser);

    const ev = new MessageEvent('message', {
      data: {
        source: INTERCEPT_SOURCE,
        type: 'CONVERSATION',
        conversationId: CONV_A,
        body: makeConv(),
      },
      origin: 'https://evil.example.com',
      source: window,
    });
    window.dispatchEvent(ev);

    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores messages with the wrong source tag', async () => {
    dispose = startOrchestrator(parser);
    window.postMessage(
      { source: 'someone-else', type: 'CONVERSATION', conversationId: CONV_A, body: makeConv() },
      location.origin,
    );
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('persists hashes to chrome.storage.local after each download', async () => {
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv());

    await vi.waitFor(() => {
      expect(mockChrome.storage.local[HASH_KEY]).toBeDefined();
    });
    const stored = mockChrome.storage.local[HASH_KEY] as Record<string, string>;
    expect(Object.keys(stored)).toEqual([CONV_A]);
    expect(typeof stored[CONV_A]).toBe('string');
    expect(stored[CONV_A]).toHaveLength(64); // SHA-256 hex
  });

  it('hydrated hashes from storage suppress duplicate downloads', async () => {
    // Pre-seed by running one download to learn the canonical hash.
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv());
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));

    // Tear down, keep storage state, start a fresh orchestrator.
    dispose();
    mockChrome.runtime.sendMessage.mockClear();
    dispose = startOrchestrator(parser);

    postFromMain(CONV_A, makeConv());
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('clearing convHashes does NOT auto-redownload (user-driven re-trigger)', async () => {
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv({ title: 'Resettable A' }));
    postFromMain(CONV_B, makeConv({ title: 'Resettable B' }));

    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(2));
    mockChrome.runtime.sendMessage.mockClear();

    // Simulate the popup's Reset button. The orchestrator should clear its
    // in-memory hash map but NOT flood downloads — re-downloads happen when
    // the user revisits a chat and Claude refetches.
    await chrome.storage.local.remove(HASH_KEY);

    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();

    // After clearing, an incoming intercept for the same conversation should
    // be treated as fresh (its prior hash is gone) and download again.
    postFromMain(CONV_A, makeConv({ title: 'Resettable A' }));
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('mirrors external convHashes updates into the in-memory map', async () => {
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv());
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));

    // External writer overwrites with a different hash for CONV_A → in-memory
    // map should pick that up. Posting the same body should still dedupe
    // (it'll re-compute the actual hash, write it back, and download once
    // because the externally-written hash doesn't match real content).
    await chrome.storage.local.set({ [HASH_KEY]: { [CONV_A]: 'externally-written-hash' } });
    mockChrome.runtime.sendMessage.mockClear();

    postFromMain(CONV_A, makeConv());
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('stops processing after Extension context is invalidated', async () => {
    dispose = startOrchestrator(parser);

    mockChrome.runtime.sendMessage.mockImplementationOnce(async () => {
      throw new Error('Extension context invalidated.');
    });

    postFromMain(CONV_A, makeConv());
    await flushMacro();
    await flushMacro();
    mockChrome.runtime.sendMessage.mockClear();

    postFromMain(CONV_B, makeConv({ title: 'After invalidation' }));
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('passes filter range label into markdown header', async () => {
    dispose = startOrchestrator(parser);
    postFromMain(CONV_A, makeConv());
    await vi.waitFor(() => expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1));

    const md = mockChrome.runtime.sendMessage.mock.calls[0]![0].content as string;
    expect(md).toMatch(/\*\*Range\*\*: \d{4}-\d{2}-\d{2}/);
  });

  it('dispose() removes window and storage listeners', async () => {
    dispose = startOrchestrator(parser);
    dispose();
    dispose = undefined; // prevent afterEach double-dispose

    postFromMain(CONV_A, makeConv());
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();

    // Storage listener gone too: clearing convHashes shouldn't fire reprocess.
    await chrome.storage.local.set({ [HASH_KEY]: { [CONV_A]: 'something' } });
    await chrome.storage.local.remove(HASH_KEY);
    await flushMacro();
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
