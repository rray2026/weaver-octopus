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
import {
  CAPTURE_DECISION_EVENT,
  type CaptureDecisionDetail,
  dispatchCaptureDecision,
} from '../captureEvents.js';
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
    extractConversationId: (link) => {
      // Tests use simple "/chat/<id>" hrefs where <id> can be any token.
      const m = link.href.match(/\/chat\/([^/?#]+)/);
      return m ? m[1]! : null;
    },
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
    expect(logs[0]!.reason).toMatch(/no decision\/download/);
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

  it('short-circuits the timeout when an out-of-range decision event fires', async () => {
    const links = [{ href: '/chat/abc', title: 'Out of range' }];
    const navigate = vi.fn(async () => {
      // Orchestrator's "no messages in date range" decision fires fast —
      // simulate that on the next microtask.
      await Promise.resolve();
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: 'abc',
        action: 'skipped:date',
        reason: 'no messages within 2026-04-01',
      });
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    const startedAt = Date.now();
    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      // Long timeout — a buggy runner would block here for 5s. The decision
      // event must short-circuit it within ~tens of ms.
      perChatTimeoutMs: 5000,
      pollIntervalMs: 50,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('skipped');
    expect(logs[0]!.reason).toMatch(/2026-04-01/);
  });

  it('treats a "downloaded" decision event as ok even before lastDownload is read', async () => {
    const links = [{ href: '/chat/xyz', title: 'Direct' }];
    const navigate = vi.fn(async () => {
      // Orchestrator's success path fires the decision event roughly when
      // it sends DOWNLOAD_REQUEST; lastDownload only updates after the
      // background commits storage. Make the decision arrive first.
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: 'xyz',
        action: 'downloaded',
      });
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 5000,
      pollIntervalMs: 50,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('ok');
  });

  it('ignores decision events for a different conversation id', async () => {
    const links = [{ href: '/chat/wanted', title: 'Real target' }];
    const navigate = vi.fn(async () => {
      // A noisy event from another tab / earlier visit fires for the WRONG
      // conversation. Runner should disregard it and keep waiting.
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: 'something-else',
        action: 'downloaded',
      });
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
    // No matching event, no download — ends as a regular timeout-skip.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('skipped');
    expect(logs[0]!.reason).toMatch(/timeout|cached|empty/i);
  });

  it('ignores decision events from the wrong provider', async () => {
    const links = [{ href: '/chat/abc', title: 'Claude target' }];
    const navigate = vi.fn(async () => {
      // A Gemini event coincidentally has the same id — must be filtered
      // out by provider.
      dispatchCaptureDecision({
        provider: 'gemini',
        conversationId: 'abc',
        action: 'downloaded',
      });
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

  it('cleans up the decision listener after each chat (no leak across iterations)', async () => {
    const links = [
      { href: '/chat/a', title: 'A' },
      { href: '/chat/b', title: 'B' },
      { href: '/chat/c', title: 'C' },
    ];
    const navigate = vi.fn(async (link: { href: string }) => {
      const id = link.href.split('/').pop()!;
      dispatchCaptureDecision({
        provider: 'claude',
        conversationId: id,
        action: 'skipped:date',
        reason: 'test',
      });
    });
    const adapter = makeAdapter({ links, navigate });
    const patches: BackfillProviderProgressPatch[] = [];

    await runBackfill(adapter, {
      minIntervalMs: 1,
      maxIntervalMs: 2,
      perChatTimeoutMs: 5000,
      pollIntervalMs: 50,
      reportPatch: async (p) => {
        patches.push(p);
      },
    });

    // After the runner returns, no listeners should be attached to the
    // capture-decision channel. Any stray listener would still fire here.
    let strayCount = 0;
    const probe = (): void => {
      strayCount++;
    };
    window.addEventListener(CAPTURE_DECISION_EVENT, probe);
    window.dispatchEvent(
      new CustomEvent(CAPTURE_DECISION_EVENT, {
        detail: {
          provider: 'claude',
          conversationId: 'a',
          action: 'downloaded',
        } satisfies CaptureDecisionDetail,
      }),
    );
    window.removeEventListener(CAPTURE_DECISION_EVENT, probe);
    expect(strayCount).toBe(1); // only the probe counted; no leaked listeners

    const logs = patches.flatMap((p) => p.appendLog ?? []);
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });
});
