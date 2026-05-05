// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INTERCEPT_SOURCE = 'weaver-octopus:intercept';
const PATCH_FLAG = '__weaverFetchPatched';

const ORG_UUID = '11111111-1111-1111-1111-111111111111';
const CONV_UUID = '22222222-2222-2222-2222-222222222222';
const CONV_URL_PATH = `/api/organizations/${ORG_UUID}/chat_conversations/${CONV_UUID}`;

interface InterceptedMessage {
  source: typeof INTERCEPT_SOURCE;
  type: 'CONVERSATION';
  conversationId: string;
  body: unknown;
}

/** Returns a Response-like stub matching the surface intercept.ts uses. */
function makeResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  // intercept.ts only calls response.clone() then response.json() and reads
  // .ok / .status. Build the minimum that satisfies that contract — using
  // Response from undici/jsdom can fail on bodies with non-JSON or non-text.
  let consumed = false;
  const r = {
    ok,
    status,
    clone() {
      // Each clone is independent: the production code clones once before
      // calling .json(); a real Response would error on a second .json() of
      // the same instance.
      return makeResponse(body, opts);
    },
    async json() {
      if (consumed) throw new Error('body already consumed');
      consumed = true;
      return body;
    },
    get bodyUsed() {
      return consumed;
    },
  };
  return r as unknown as Response;
}

/** Subscribes to window.postMessage events fired by intercept and returns a getter. */
function captureMessages(): {
  messages: InterceptedMessage[];
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
  dispose: () => void;
} {
  const messages: InterceptedMessage[] = [];
  const handler = (e: MessageEvent) => {
    const data = e.data as InterceptedMessage | undefined;
    if (data && data.source === INTERCEPT_SOURCE) messages.push(data);
  };
  window.addEventListener('message', handler);
  return {
    messages,
    async waitFor(n, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    dispose: () => window.removeEventListener('message', handler),
  };
}

describe('intercept (MAIN-world fetch patch)', () => {
  let originalFetch: typeof window.fetch;
  let baseFetch: ReturnType<typeof vi.fn>;
  let capture: ReturnType<typeof captureMessages>;

  beforeEach(async () => {
    originalFetch = window.fetch;
    // Provide a baseline fetch the intercept will wrap. Each test overrides
    // the resolved value via mockResolvedValueOnce.
    baseFetch = vi.fn();
    window.fetch = baseFetch as unknown as typeof window.fetch;
    // Force a fresh patch each test — the IIFE early-exits on PATCH_FLAG.
    delete (window as unknown as Record<string, unknown>)[PATCH_FLAG];
    vi.resetModules();
    await import('./intercept.js');
    capture = captureMessages();
  });

  afterEach(() => {
    capture.dispose();
    window.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>)[PATCH_FLAG];
  });

  it('sets the __weaverFetchPatched flag on install', () => {
    expect((window as unknown as Record<string, unknown>)[PATCH_FLAG]).toBe(true);
  });

  it('forwards a conversation GET to the isolated world via postMessage', async () => {
    const body = { uuid: CONV_UUID, name: 'X', chat_messages: [] };
    baseFetch.mockResolvedValueOnce(makeResponse(body));

    await window.fetch(CONV_URL_PATH);
    await capture.waitFor(1);

    expect(capture.messages).toHaveLength(1);
    expect(capture.messages[0]).toMatchObject({
      source: INTERCEPT_SOURCE,
      type: 'CONVERSATION',
      conversationId: CONV_UUID,
      body,
    });
  });

  it('extracts the conversation id even when the URL has a trailing slash or query', async () => {
    baseFetch.mockResolvedValueOnce(
      makeResponse({ uuid: CONV_UUID, chat_messages: [] }),
    );
    await window.fetch(`${CONV_URL_PATH}?tree=true`);
    await capture.waitFor(1);

    expect(capture.messages[0]?.conversationId).toBe(CONV_UUID);
  });

  it('ignores non-conversation /api/ URLs (regex correctness)', async () => {
    baseFetch.mockResolvedValueOnce(makeResponse({ unrelated: true }));
    await window.fetch(`/api/organizations/${ORG_UUID}/projects`);
    // Wait long enough that, if the message were going to fire, it would have.
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('skips non-GET requests to a conversation URL', async () => {
    baseFetch.mockResolvedValueOnce(makeResponse({ chat_messages: [] }));
    await window.fetch(CONV_URL_PATH, { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('reads method off Request objects (not just init)', async () => {
    baseFetch.mockResolvedValueOnce(makeResponse({ chat_messages: [] }));
    // Pass a Request-like object with method=DELETE — intercept must consult
    // input.method rather than defaulting to GET.
    const req = { url: CONV_URL_PATH, method: 'DELETE' } as Request;
    await window.fetch(req);
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('skips when the response is not ok (e.g. 401/500)', async () => {
    baseFetch.mockResolvedValueOnce(
      makeResponse({ chat_messages: [] }, { ok: false, status: 401 }),
    );
    await window.fetch(CONV_URL_PATH);
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('skips when the body lacks chat_messages array', async () => {
    baseFetch.mockResolvedValueOnce(makeResponse({ uuid: CONV_UUID, name: 'X' }));
    await window.fetch(CONV_URL_PATH);
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('skips when chat_messages is the wrong type (e.g. object)', async () => {
    baseFetch.mockResolvedValueOnce(
      makeResponse({ uuid: CONV_UUID, chat_messages: { not: 'an array' } }),
    );
    await window.fetch(CONV_URL_PATH);
    await new Promise((r) => setTimeout(r, 30));

    expect(capture.messages).toHaveLength(0);
  });

  it('still returns the original response to the caller, even when forwarding', async () => {
    const body = { chat_messages: [] };
    baseFetch.mockResolvedValueOnce(makeResponse(body));

    const res = await window.fetch(CONV_URL_PATH);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('does not re-patch on subsequent imports (idempotent IIFE)', async () => {
    const patchedFetch = window.fetch;
    vi.resetModules();
    await import('./intercept.js');
    expect(window.fetch).toBe(patchedFetch);
  });

  it('matches URLs given as URL objects, not just strings', async () => {
    baseFetch.mockResolvedValueOnce(
      makeResponse({ uuid: CONV_UUID, chat_messages: [] }),
    );
    // Use the dummy origin jsdom assigns by default.
    const url = new URL(CONV_URL_PATH, 'http://localhost/');
    await window.fetch(url);
    await capture.waitFor(1);

    expect(capture.messages[0]?.conversationId).toBe(CONV_UUID);
  });
});
