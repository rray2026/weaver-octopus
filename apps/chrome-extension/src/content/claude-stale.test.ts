// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../test/chromeMock.js';
import { onClaudeStale, startClaudeStaleListener } from './claude-stale.js';

const SOURCE = 'weaver-octopus:intercept';
const HASH_KEY = 'convHashes';

function postStale(conversationId: string): void {
  const ev = new MessageEvent('message', {
    data: { source: SOURCE, type: 'STALE_CONVERSATION', conversationId },
    origin: location.origin,
    source: window,
  });
  window.dispatchEvent(ev);
}

async function flushAsync(loops = 30): Promise<void> {
  for (let i = 0; i < loops; i++) await Promise.resolve();
}

describe('claude-stale listener', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
    startClaudeStaleListener();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('removes the matching entry from convHashes on STALE_CONVERSATION', async () => {
    mock.storage.local[HASH_KEY] = {
      'aaa': 'hash-a',
      'bbb': 'hash-b',
    };
    postStale('aaa');
    await flushAsync();

    expect(mock.storage.local[HASH_KEY]).toEqual({ bbb: 'hash-b' });
  });

  it('is a no-op when convHashes does not contain the conversation id', async () => {
    mock.storage.local[HASH_KEY] = { 'other': 'h' };
    postStale('not-stored');
    await flushAsync();
    expect(mock.storage.local[HASH_KEY]).toEqual({ other: 'h' });
  });

  it('handles missing convHashes (storage empty) without throwing', async () => {
    postStale('aaa');
    await flushAsync();
    expect(mock.storage.local[HASH_KEY]).toBeUndefined();
  });

  it('fires subscribed listeners with the conversation id', async () => {
    const listener = vi.fn();
    onClaudeStale(listener);
    postStale('xyz');
    await flushAsync();
    expect(listener).toHaveBeenCalledWith('xyz');
  });

  it('ignores messages from a foreign origin', async () => {
    mock.storage.local[HASH_KEY] = { aaa: 'h' };
    const ev = new MessageEvent('message', {
      data: { source: SOURCE, type: 'STALE_CONVERSATION', conversationId: 'aaa' },
      origin: 'https://evil.example.com',
      source: window,
    });
    window.dispatchEvent(ev);
    await flushAsync();
    expect(mock.storage.local[HASH_KEY]).toEqual({ aaa: 'h' });
  });

  it('ignores messages with the wrong source tag', async () => {
    mock.storage.local[HASH_KEY] = { aaa: 'h' };
    const ev = new MessageEvent('message', {
      data: { source: 'someone-else', type: 'STALE_CONVERSATION', conversationId: 'aaa' },
      origin: location.origin,
      source: window,
    });
    window.dispatchEvent(ev);
    await flushAsync();
    expect(mock.storage.local[HASH_KEY]).toEqual({ aaa: 'h' });
  });

  it('subscriber unsubscribe stops further callbacks', async () => {
    const listener = vi.fn();
    const off = onClaudeStale(listener);
    postStale('a');
    await flushAsync();
    off();
    postStale('b');
    await flushAsync();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('a');
  });
});
