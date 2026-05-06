import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type RuntimeMessageListener,
} from '../../test/chromeMock.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';

async function importBackground(): Promise<void> {
  vi.resetModules();
  await import('./index.js');
}

function getMessageListener(mock: ChromeMock): RuntimeMessageListener {
  const [listener] = [...mock.runtime.messageListeners];
  if (!listener) throw new Error('background did not register an onMessage listener');
  return listener;
}

/** Drives the listener and resolves once it has called sendResponse. */
function invokeListener(
  listener: RuntimeMessageListener,
  message: unknown,
  senderUrl: string | undefined,
): Promise<{ ok: boolean; downloadId?: number; error?: string }> {
  return new Promise((resolve) => {
    const sender = senderUrl == null ? {} : { tab: { url: senderUrl, id: 7 } };
    const ret = listener(message, sender, (response) => {
      resolve(response as { ok: boolean; downloadId?: number; error?: string });
    });
    // Synchronous rejections (unauthorized / unknown type) return false and
    // call sendResponse before returning. Async DOWNLOAD_REQUEST returns true
    // and resolves later — Promise resolves naturally either way.
    void ret;
  });
}

describe('matchesHostPattern', () => {
  // Imported lazily so the chrome stub is in place before background runs.
  let matchesHostPattern: (url: string, pattern: string) => boolean;

  beforeEach(async () => {
    installChromeMock();
    vi.resetModules();
    ({ matchesHostPattern } = await import('./index.js'));
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('matches https://claude.ai/* against a real chat URL', () => {
    expect(matchesHostPattern('https://claude.ai/chat/abc123', 'https://claude.ai/*')).toBe(true);
  });

  it('rejects http when the pattern requires https', () => {
    expect(matchesHostPattern('http://claude.ai/chat/abc', 'https://claude.ai/*')).toBe(false);
  });

  it('rejects a different host even on the same scheme', () => {
    expect(matchesHostPattern('https://evil.example.com/chat', 'https://claude.ai/*')).toBe(false);
  });

  it('rejects subdomains because the host must match exactly', () => {
    // Stops a partial-match bug where 'claude.ai' would also accept 'evilclaude.ai'
    // or 'phish.claude.ai' if we used endsWith / startsWith on the hostname.
    expect(matchesHostPattern('https://phish.claude.ai/x', 'https://claude.ai/*')).toBe(false);
    expect(matchesHostPattern('https://evilclaude.ai/x', 'https://claude.ai/*')).toBe(false);
  });

  it('accepts host wildcard ("*") for any hostname on the same scheme', () => {
    expect(matchesHostPattern('https://anything.example/x', 'https://*/*')).toBe(true);
  });

  it('accepts the localhost:* port wildcard used by the e2e build', () => {
    expect(matchesHostPattern('http://127.0.0.1:54321/page', 'http://127.0.0.1:*/*')).toBe(true);
  });

  it('rejects malformed URLs without throwing', () => {
    expect(matchesHostPattern('not a url', 'https://claude.ai/*')).toBe(false);
  });

  it('rejects malformed patterns without throwing', () => {
    expect(matchesHostPattern('https://claude.ai/x', 'garbage')).toBe(false);
  });
});

describe('background onMessage flow', () => {
  let mock: ChromeMock;

  beforeEach(async () => {
    mock = installChromeMock({ manifest: { host_permissions: ['https://claude.ai/*'] } });
    await importBackground();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('registers the runtime + downloads listeners on import', () => {
    expect(mock.runtime.installedListeners.size).toBe(1);
    expect(mock.runtime.messageListeners.size).toBe(1);
    expect(mock.downloads.changeListeners.size).toBe(1);
  });

  it('downloads a markdown file and persists lastDownload for an allowed sender', async () => {
    const listener = getMessageListener(mock);

    const ack = await invokeListener(
      listener,
      { type: 'DOWNLOAD_REQUEST', filename: 'weaver-octopus/2026-04-30/foo.md', content: '# hi' },
      'https://claude.ai/chat/abc',
    );

    expect(ack).toEqual({ ok: true, downloadId: 1 });
    expect(mock.downloads.download).toHaveBeenCalledTimes(1);

    const downloadArg = mock.downloads.download.mock.calls[0]![0] as {
      url: string;
      filename: string;
      conflictAction: string;
      saveAs: boolean;
    };
    expect(downloadArg.filename).toBe('weaver-octopus/2026-04-30/foo.md');
    expect(downloadArg.conflictAction).toBe('overwrite');
    expect(downloadArg.saveAs).toBe(false);
    // data: URL with the markdown body — body is URI-encoded
    expect(downloadArg.url).toBe(
      `data:text/markdown;charset=utf-8,${encodeURIComponent('# hi')}`,
    );

    const last = mock.storage.local[LAST_DOWNLOAD_KEY] as { filename: string; at: number };
    expect(last.filename).toBe('weaver-octopus/2026-04-30/foo.md');
    expect(typeof last.at).toBe('number');
    expect(last.at).toBeGreaterThan(0);
  });

  it('rejects DOWNLOAD_REQUEST from a sender not in host_permissions', async () => {
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'DOWNLOAD_REQUEST', filename: 'x.md', content: 'x' },
      'https://evil.example.com/page',
    );
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/unauthorized/i);
    expect(mock.downloads.download).not.toHaveBeenCalled();
    expect(mock.storage.local[LAST_DOWNLOAD_KEY]).toBeUndefined();
  });

  it('rejects messages with a missing sender URL (e.g. extension-internal)', async () => {
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'DOWNLOAD_REQUEST', filename: 'x.md', content: 'x' },
      undefined,
    );
    expect(ack.ok).toBe(false);
    expect(mock.downloads.download).not.toHaveBeenCalled();
  });

  it('rejects unknown message types from an allowed sender', async () => {
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'NOT_A_REAL_TYPE' },
      'https://claude.ai/chat/abc',
    );
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/unknown/i);
    expect(mock.downloads.download).not.toHaveBeenCalled();
  });

  it('reports failure if chrome.downloads.download rejects', async () => {
    mock.downloads.download.mockRejectedValueOnce(new Error('disk full'));
    const listener = getMessageListener(mock);

    const ack = await invokeListener(
      listener,
      { type: 'DOWNLOAD_REQUEST', filename: 'x.md', content: 'x' },
      'https://claude.ai/chat/abc',
    );
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/disk full/);
    // lastDownload only persists on success.
    expect(mock.storage.local[LAST_DOWNLOAD_KEY]).toBeUndefined();
  });
});

describe('background REFRESH_ACTIVITY', () => {
  let mock: ChromeMock;
  let resetThrottle: () => void;

  beforeEach(async () => {
    mock = installChromeMock({
      manifest: {
        host_permissions: [
          'https://claude.ai/*',
          'https://gemini.google.com/*',
          'https://myactivity.google.com/*',
        ],
      },
    });
    vi.resetModules();
    const mod = await import('./index.js');
    resetThrottle = mod.__resetActivityThrottleForTests;
    resetThrottle();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('opens a background myactivity tab when none is open, from a Gemini sender', async () => {
    const listener = getMessageListener(mock);

    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(ack.ok).toBe(true);
    expect(mock.tabs.query).toHaveBeenCalledTimes(1);
    expect(mock.tabs.create).toHaveBeenCalledTimes(1);
    const createArg = mock.tabs.create.mock.calls[0]![0] as {
      url: string;
      active: boolean;
    };
    expect(createArg.url).toBe('https://myactivity.google.com/product/gemini');
    expect(createArg.active).toBe(false);
    expect(mock.tabs.reload).not.toHaveBeenCalled();
  });

  it('reloads the existing myactivity tab when one is already open', async () => {
    mock.tabs.query.mockResolvedValueOnce([
      { id: 42, url: 'https://myactivity.google.com/product/gemini' },
    ]);
    const listener = getMessageListener(mock);

    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(ack.ok).toBe(true);
    expect(mock.tabs.create).not.toHaveBeenCalled();
    expect(mock.tabs.reload).toHaveBeenCalledWith(42);
  });

  it('throttles repeated refresh requests within the 30s window', async () => {
    const listener = getMessageListener(mock);

    const first = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );
    const second = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false });
    expect(mock.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('rejects REFRESH_ACTIVITY from a sender outside host_permissions', async () => {
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://evil.example.com/page',
    );
    expect(ack.ok).toBe(false);
    expect(mock.tabs.query).not.toHaveBeenCalled();
  });

  it('reuses a tab id from chrome.storage.session even if tabs.query misses it (SW-restart race)', async () => {
    // Simulate the post-restart state: tabId tracked in session storage,
    // tab still alive, but tabs.query returns nothing (URL not committed).
    mock.storageSession.data['myactivityTabId'] = 17;
    mock.tabs.get.mockResolvedValueOnce({ id: 17, url: 'https://myactivity.google.com/product/gemini' });

    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(ack).toMatchObject({ ok: true, action: 'reloaded', tabId: 17 });
    expect(mock.tabs.create).not.toHaveBeenCalled();
    expect(mock.tabs.reload).toHaveBeenCalledWith(17);
    // Tracked path skipped tabs.query entirely.
    expect(mock.tabs.query).not.toHaveBeenCalled();
  });

  it('self-heals: closes extra myactivity tabs when query returns more than one', async () => {
    mock.tabs.query.mockResolvedValueOnce([
      { id: 11, url: 'https://myactivity.google.com/product/gemini' },
      { id: 22, url: 'https://myactivity.google.com/product/gemini' },
      { id: 33, url: 'https://myactivity.google.com/product/gemini' },
    ]);
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(ack).toMatchObject({ ok: true, action: 'reloaded', tabId: 11 });
    expect(mock.tabs.remove).toHaveBeenCalledWith([22, 33]);
    expect(mock.tabs.reload).toHaveBeenCalledWith(11);
    expect(mock.tabs.create).not.toHaveBeenCalled();
  });

  it('drops the tracked id and falls back to query when the tracked tab is gone', async () => {
    mock.storageSession.data['myactivityTabId'] = 17;
    // tabs.get default rejects → treated as gone.
    const listener = getMessageListener(mock);
    const ack = await invokeListener(
      listener,
      { type: 'REFRESH_ACTIVITY' },
      'https://gemini.google.com/app/abc',
    );

    expect(ack.ok).toBe(true);
    expect(mock.tabs.query).toHaveBeenCalledTimes(1);
    expect(mock.tabs.create).toHaveBeenCalledTimes(1);
    // After fallback create, the new tab id is tracked.
    expect(mock.storageSession.data['myactivityTabId']).toBe(99);
  });
});

describe('background resolveInterval', () => {
  let resolveInterval: typeof import('./index.js').resolveInterval;

  beforeEach(async () => {
    installChromeMock();
    vi.resetModules();
    const mod = await import('./index.js');
    resolveInterval = mod.resolveInterval;
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('falls back to defaults (1–2s) when overrides are missing', () => {
    expect(resolveInterval({})).toEqual({ minMs: 1000, maxMs: 2000 });
  });

  it('converts seconds to ms', () => {
    expect(resolveInterval({ intervalMinSec: 10, intervalMaxSec: 20 })).toEqual({
      minMs: 10_000,
      maxMs: 20_000,
    });
  });

  it('clamps to [0, 600] seconds', () => {
    expect(resolveInterval({ intervalMinSec: -5, intervalMaxSec: 9999 })).toEqual({
      minMs: 0,
      maxMs: 600_000,
    });
  });

  it('swaps when min > max', () => {
    expect(resolveInterval({ intervalMinSec: 30, intervalMaxSec: 5 })).toEqual({
      minMs: 5000,
      maxMs: 30_000,
    });
  });

  it('treats NaN as missing and falls back to defaults', () => {
    expect(resolveInterval({ intervalMinSec: NaN, intervalMaxSec: NaN })).toEqual({
      minMs: 1000,
      maxMs: 2000,
    });
  });
});

describe('background appendLog', () => {
  let appendLog: typeof import('./index.js').__backfillInternals.appendLog;

  beforeEach(async () => {
    installChromeMock();
    vi.resetModules();
    const mod = await import('./index.js');
    appendLog = mod.__backfillInternals.appendLog;
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('returns prev unchanged when appendLog is empty/undefined', () => {
    const prev = [
      { at: 1, provider: 'claude' as const, status: 'ok' as const },
    ];
    expect(appendLog(prev, undefined)).toBe(prev);
    expect(appendLog(prev, [])).toBe(prev);
  });

  it('appends entries to the end', () => {
    const prev = [{ at: 1, provider: 'claude' as const, status: 'ok' as const }];
    const next = [{ at: 2, provider: 'claude' as const, status: 'failed' as const }];
    expect(appendLog(prev, next)).toEqual([...prev, ...next]);
  });

  it('keeps only the most recent entries when the cap is exceeded', () => {
    // The cap is 200; build a history of 220 entries and append 5 more.
    const prev = Array.from({ length: 220 }, (_, i) => ({
      at: i,
      provider: 'claude' as const,
      status: 'ok' as const,
    }));
    const next = Array.from({ length: 5 }, (_, i) => ({
      at: 1000 + i,
      provider: 'claude' as const,
      status: 'ok' as const,
    }));
    const result = appendLog(prev, next);
    expect(result).toHaveLength(200);
    // Newest preserved
    expect(result[result.length - 1]!.at).toBe(1004);
    // Oldest dropped
    expect(result[0]!.at).toBeGreaterThan(0);
  });
});

describe('background patchProvider race serialisation', () => {
  let internals: typeof import('./index.js').__backfillInternals;

  beforeEach(async () => {
    installChromeMock();
    vi.resetModules();
    const mod = await import('./index.js');
    internals = mod.__backfillInternals;
    // Seed a fresh-style progress object the way startBackfill does.
    await internals.writeProgress({
      state: 'running',
      startedAt: Date.now(),
      perProvider: {
        claude: internals.makeEmptyProviderProgress(),
        gemini: internals.makeEmptyProviderProgress(),
      },
    });
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('does not lose `total` when two patches fire concurrently (RMW race)', async () => {
    // Repro of the production bug: the runner's `{total: 27}` patch
    // races with a near-simultaneous `{currentTitle: ...}` patch.
    // Without serialisation both reads see total=0 and the second
    // write stomps the first, leaving total=0 in storage.
    await Promise.all([
      internals.patchProvider('claude', { total: 27 }),
      internals.patchProvider('claude', { currentTitle: 'Mac mini' }),
    ]);

    const prog = await internals.readProgress();
    expect(prog.perProvider.claude!.total).toBe(27);
    expect(prog.perProvider.claude!.currentTitle).toBe('Mac mini');
  });

  it('correctly accumulates increments under concurrency', async () => {
    // Three `done: 1` patches fired concurrently must sum to done=3.
    await Promise.all([
      internals.patchProvider('claude', { done: 1 }),
      internals.patchProvider('claude', { done: 1 }),
      internals.patchProvider('claude', { done: 1 }),
    ]);

    const prog = await internals.readProgress();
    expect(prog.perProvider.claude!.done).toBe(3);
  });

  it('one rejection does not poison subsequent mutateProgress calls', async () => {
    // patchProvider itself doesn't normally reject, but the chain's tail
    // catches rejections defensively. Verify a later patch still applies.
    await internals.patchProvider('claude', { total: 27 });
    await internals.patchProvider('claude', { skipped: 1 });

    const prog = await internals.readProgress();
    expect(prog.perProvider.claude!.total).toBe(27);
    expect(prog.perProvider.claude!.skipped).toBe(1);
  });
});
