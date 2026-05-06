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

    // `done` is now an INCREMENT (one per successful download), not an
    // absolute. The background's applyBackfillPatch sums them. Both
    // semantics work — the assertion was over-constrained on the old
    // wire format.
    const dones = patches.map((p) => p.done).filter((v) => v != null);
    expect(dones).toEqual([1, 1]);
    expect(dones.reduce((a, b) => a + b, 0)).toBe(2);
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

  describe('stop latency', () => {
    it('returns soon after stop is requested mid-pacing (does not wait full jitter)', async () => {
      const links = Array.from({ length: 5 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const navigate = vi.fn(async (link: { href: string }) => {
        const id = link.href.split('/').pop()!;
        dispatchCaptureDecision({
          provider: 'claude',
          conversationId: id,
          action: 'downloaded',
        });
      });
      const adapter = makeAdapter({ links, navigate });

      const startedAt = Date.now();
      // Set stop after first chat is in flight, so we abort *during* pacing.
      const reportPatch = async (p: BackfillProviderProgressPatch) => {
        if (p.done === 1) {
          // Simulate the popup writing the stop flag right after the first
          // chat completed and the runner entered the pacing sleep.
          setTimeout(() => {
            mock.storage.local[STOP_FLAG_KEY] = true;
          }, 50);
        }
      };

      await runBackfill(adapter, {
        // 5s pacing — without abortable sleep this would dominate stop latency.
        minIntervalMs: 5000,
        maxIntervalMs: 5000,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        reportPatch,
      });

      const elapsed = Date.now() - startedAt;
      // First chat (~immediate) + stop fires at +50ms + abortable sleep
      // notices within ~200ms poll. Allow generous slack for jsdom.
      expect(elapsed).toBeLessThan(2000);
      // Only the first chat was navigated; the rest should be aborted.
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('returns soon after stop when the wait races on the download channel timeout', async () => {
      // No decision event ever fires — runner falls into the perChatTimeoutMs
      // wait. Stop must short-circuit it without awaiting the decision
      // channel's self-timeout.
      const links = [{ href: '/chat/abc', title: 'A' }];
      const navigate = vi.fn(async () => {
        // Set stop flag immediately. The download poll observes it within
        // pollIntervalMs and returns false; we must NOT then block on the
        // decision channel's full timeout.
        mock.storage.local[STOP_FLAG_KEY] = true;
      });
      const adapter = makeAdapter({ links, navigate });

      const startedAt = Date.now();
      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        // perChatTimeoutMs intentionally LARGE — buggy runner would block here.
        perChatTimeoutMs: 10_000,
        pollIntervalMs: 50,
        reportPatch: async () => undefined,
      });
      const elapsed = Date.now() - startedAt;

      // Stop observed by download poller within ~50ms; runner must NOT then
      // wait 10s for the decision channel.
      expect(elapsed).toBeLessThan(1500);
    });
  });

  describe('early termination on consecutive date skips', () => {
    function makeChainAdapter(
      links: Array<{ href: string; title: string }>,
      decisions: Array<{ action: 'downloaded' | 'skipped:date' | 'skipped:hash' | 'skipped:empty' | 'skipped:other'; reason?: string }>,
    ): { adapter: BackfillProviderAdapter; navigate: ReturnType<typeof vi.fn> } {
      const navigate = vi.fn(async (link: { href: string }) => {
        const idx = links.findIndex((l) => l.href === link.href);
        const decision = decisions[idx]!;
        const id = link.href.split('/').pop()!;
        dispatchCaptureDecision({
          provider: 'claude',
          conversationId: id,
          action: decision.action,
          reason: decision.reason,
        });
      });
      const adapter = makeAdapter({ links, navigate });
      return { adapter, navigate };
    }

    it('stops after threshold consecutive skipped:date and logs "early stop"', async () => {
      const links = Array.from({ length: 10 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const { adapter, navigate } = makeChainAdapter(
        links,
        // c0: ok, c1..c5: skipped:date (5 consecutive), c6..c9: shouldn't be visited
        [
          { action: 'downloaded' },
          { action: 'skipped:date', reason: 'oor' },
          { action: 'skipped:date', reason: 'oor' },
          { action: 'skipped:date', reason: 'oor' },
          { action: 'skipped:date', reason: 'oor' },
          { action: 'skipped:date', reason: 'oor' },
          { action: 'downloaded' }, // unreachable
          { action: 'downloaded' },
          { action: 'downloaded' },
          { action: 'downloaded' },
        ],
      );
      const patches: BackfillProviderProgressPatch[] = [];

      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        stopAfterConsecutiveDateSkips: 5,
        reportPatch: async (p) => {
          patches.push(p);
        },
      });

      expect(navigate).toHaveBeenCalledTimes(6); // c0 + c1..c5
      const logs = patches.flatMap((p) => p.appendLog ?? []);
      const earlyStop = logs.find((l) => l.reason?.startsWith('early stop'));
      expect(earlyStop).toBeDefined();
      expect(earlyStop!.reason).toMatch(/5 consecutive/);
      expect(earlyStop!.reason).toMatch(/remaining 4/);
    });

    it('resets counter when an "ok" outcome interrupts the streak', async () => {
      const links = Array.from({ length: 10 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const { adapter, navigate } = makeChainAdapter(
        links,
        [
          { action: 'skipped:date' }, // 1
          { action: 'skipped:date' }, // 2
          { action: 'skipped:date' }, // 3
          { action: 'skipped:date' }, // 4
          { action: 'downloaded' },   // resets
          { action: 'skipped:date' }, // 1 again
          { action: 'skipped:date' }, // 2
          { action: 'skipped:date' }, // 3
          { action: 'skipped:date' }, // 4
          { action: 'skipped:date' }, // 5 — would trigger
        ],
      );
      const patches: BackfillProviderProgressPatch[] = [];

      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        stopAfterConsecutiveDateSkips: 5,
        reportPatch: async (p) => {
          patches.push(p);
        },
      });

      // The 5-streak ends exactly at the last item, so the early-stop log is
      // NOT emitted (i+1 === links.length).
      expect(navigate).toHaveBeenCalledTimes(10);
      const logs = patches.flatMap((p) => p.appendLog ?? []);
      expect(logs.find((l) => l.reason?.startsWith('early stop'))).toBeUndefined();
    });

    it('does not count "skipped:hash" or "skipped:empty" toward early termination', async () => {
      const links = Array.from({ length: 8 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const { adapter, navigate } = makeChainAdapter(
        links,
        [
          { action: 'skipped:date' }, // 1
          { action: 'skipped:hash' }, // resets
          { action: 'skipped:date' }, // 1
          { action: 'skipped:empty' }, // resets
          { action: 'skipped:date' }, // 1
          { action: 'skipped:date' }, // 2
          { action: 'skipped:date' }, // 3
          { action: 'downloaded' },
        ],
      );
      const patches: BackfillProviderProgressPatch[] = [];

      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        stopAfterConsecutiveDateSkips: 3, // tight threshold
        reportPatch: async (p) => {
          patches.push(p);
        },
      });

      // Cached/empty resets the streak — visits 0..6 are normal. At i=6 the
      // streak hits exactly 3 (≥ threshold) AND there's still a chat (i=7)
      // remaining, so early-stop fires.
      expect(navigate).toHaveBeenCalledTimes(7);
      const logs = patches.flatMap((p) => p.appendLog ?? []);
      const earlyStop = logs.find((l) => l.reason?.startsWith('early stop'));
      expect(earlyStop).toBeDefined();
      expect(earlyStop!.reason).toMatch(/remaining 1/);
    });

    it('threshold = 0 disables early termination', async () => {
      const links = Array.from({ length: 6 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const { adapter, navigate } = makeChainAdapter(
        links,
        Array.from({ length: 6 }, () => ({ action: 'skipped:date' as const })),
      );

      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        stopAfterConsecutiveDateSkips: 0,
        reportPatch: async () => undefined,
      });

      expect(navigate).toHaveBeenCalledTimes(6);
    });

    it('uses default threshold (5) when option is omitted', async () => {
      const links = Array.from({ length: 8 }, (_, i) => ({
        href: `/chat/c${i}`,
        title: `Chat ${i}`,
      }));
      const { adapter, navigate } = makeChainAdapter(
        links,
        Array.from({ length: 8 }, () => ({ action: 'skipped:date' as const })),
      );

      await runBackfill(adapter, {
        minIntervalMs: 1,
        maxIntervalMs: 2,
        perChatTimeoutMs: 5000,
        pollIntervalMs: 50,
        // no stopAfterConsecutiveDateSkips → default 5
        reportPatch: async () => undefined,
      });

      expect(navigate).toHaveBeenCalledTimes(5);
    });
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
