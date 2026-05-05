// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../../test/chromeMock.js';
import {
  jitter,
  runBackfill,
  type BackfillProviderAdapter,
} from './runner.js';
import type { BackfillProviderProgressPatch } from '../../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const STOP_FLAG_KEY = 'backfillStopRequested';

function makeAdapter(opts: {
  links: Array<{ href: string; title: string }>;
  navigate: (link: { href: string }) => Promise<void>;
}): BackfillProviderAdapter {
  return {
    provider: 'claude',
    logTag: 'test',
    enumerate: async () => opts.links,
    navigate: opts.navigate,
    matchesProviderFilename: (fn) => fn.includes('[claude]'),
  };
}

describe('jitter', () => {
  it('returns minMs when min === max', () => {
    expect(jitter(5000, 5000)).toBe(5000);
  });

  it('returns a value within [minMs, maxMs)', () => {
    for (let i = 0; i < 100; i++) {
      const v = jitter(4000, 6000);
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThan(6000);
    }
  });
});

describe('runBackfill', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.useRealTimers();
  });

  it('reports total at the start, then ok per chat as lastDownload advances', async () => {
    const links = [
      { href: '/chat/a', title: 'Chat A' },
      { href: '/chat/b', title: 'Chat B' },
    ];
    const navigate = vi.fn(async (link: { href: string }) => {
      // Simulate the orchestrator producing a download for this chat right after navigate.
      await Promise.resolve();
      mock.storage.local[LAST_DOWNLOAD_KEY] = {
        filename: `weaver-octopus/2026/[claude] ${link.href}.md`,
        at: Date.now() + Math.random(),
      };
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 200,
      pollIntervalMs: 5,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    expect(navigate).toHaveBeenCalledTimes(2);
    expect(patches[0]).toEqual({ total: 2 });

    const okEntries = patches.flatMap((p) => p.appendLog ?? []).filter((e) => e.status === 'ok');
    expect(okEntries).toHaveLength(2);
    expect(okEntries[0]!.title).toBe('Chat A');
    expect(okEntries[1]!.title).toBe('Chat B');

    const dones = patches.map((p) => p.done).filter((v) => v != null);
    expect(dones[dones.length - 1]).toBe(2);
  });

  it('logs "skipped" when no download is observed within the per-chat timeout', async () => {
    const links = [{ href: '/chat/a', title: 'Chat A' }];
    const adapter = makeAdapter({
      links,
      navigate: async () => undefined, // no download produced
    });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 100,
      pollIntervalMs: 20,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('skipped');
    expect(logs[0]!.reason).toMatch(/no download captured/);
  });

  it('logs "failed" when navigate throws, then continues to the next link', async () => {
    const links = [
      { href: '/chat/a', title: 'Chat A' },
      { href: '/chat/b', title: 'Chat B' },
    ];
    const navigate = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async () => {
        mock.storage.local[LAST_DOWNLOAD_KEY] = {
          filename: '[claude] B.md',
          at: Date.now(),
        };
      });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 100,
      pollIntervalMs: 5,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.status).toBe('failed');
    expect(logs[0]!.reason).toMatch(/boom/);
    expect(logs[1]!.status).toBe('ok');
  });

  it('aborts when the stop flag is set, with a "stopped by user" log entry', async () => {
    const links = [
      { href: '/chat/a', title: 'Chat A' },
      { href: '/chat/b', title: 'Chat B' },
    ];
    const navigate = vi.fn(async (link: { href: string }) => {
      mock.storage.local[LAST_DOWNLOAD_KEY] = {
        filename: `[claude] ${link.href}.md`,
        at: Date.now(),
      };
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 100,
      pollIntervalMs: 5,
      reportPatch: async (p) => {
        patches.push(p);
        // Once the first chat finishes ok, request stop. The runner checks
        // the flag at the top of each iteration, so chat B should be skipped.
        if (p.done === 1) mock.storage.local[STOP_FLAG_KEY] = true;
      },
    });

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs[0]!.status).toBe('ok');
    expect(logs[logs.length - 1]!.reason).toMatch(/stopped by user/);
    // Second chat must NOT have been navigated to.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores downloads that look like they came from a different provider', async () => {
    const links = [{ href: '/chat/a', title: 'Chat A' }];
    const navigate = vi.fn(async () => {
      // A "stale" download from the other provider arrives — runner must NOT
      // count it as the chat completing.
      mock.storage.local[LAST_DOWNLOAD_KEY] = {
        filename: 'weaver-octopus/2026/[gemini] something.md',
        at: Date.now(),
      };
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 80,
      pollIntervalMs: 10,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('skipped');
  });
});
