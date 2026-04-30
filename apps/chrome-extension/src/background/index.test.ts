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
