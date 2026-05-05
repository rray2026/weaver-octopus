// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../test/chromeMock.js';
import {
  processClaudeBody,
  processClaudeChatById,
} from './claude-fetch-core.js';
import { ClaudeParser } from './providers/claude.js';
import { CAPTURE_DECISION_EVENT, type CaptureDecisionDetail } from './captureEvents.js';

const HASH_KEY = 'convHashes';
const ORG_KEY = 'claudeOrgId';
const CONV_ID = '11111111-aaaa-bbbb-cccc-111111111111';

function makeBody(messages: Array<{ uuid: string; sender: 'human' | 'assistant'; text: string; createdAt: string }>): unknown {
  return {
    uuid: CONV_ID,
    name: 'Test Chat',
    chat_messages: messages.map((m) => ({
      uuid: m.uuid,
      sender: m.sender,
      created_at: m.createdAt,
      content: [{ type: 'text', text: m.text }],
    })),
  };
}

function listenForDecision(): { onceMatching: (filter: (d: CaptureDecisionDetail) => boolean) => Promise<CaptureDecisionDetail> } {
  const events: CaptureDecisionDetail[] = [];
  const listener = (ev: Event): void => {
    const d = (ev as CustomEvent<CaptureDecisionDetail>).detail;
    if (d) events.push(d);
  };
  window.addEventListener(CAPTURE_DECISION_EVENT, listener);
  return {
    onceMatching: async (filter) => {
      // Allow any pending dispatches to land.
      for (let i = 0; i < 30; i++) {
        const found = events.find(filter);
        if (found) {
          window.removeEventListener(CAPTURE_DECISION_EVENT, listener);
          return found;
        }
        await Promise.resolve();
      }
      window.removeEventListener(CAPTURE_DECISION_EVENT, listener);
      throw new Error(`no matching decision; saw: ${JSON.stringify(events)}`);
    },
  };
}

describe('processClaudeBody', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock({ manifest: { host_permissions: ['https://claude.ai/*'] } });
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('downloads when messages are in range, writes hash, dispatches "downloaded"', async () => {
    const now = Date.now();
    const body = makeBody([
      { uuid: 'm1', sender: 'human', text: 'hello', createdAt: new Date(now).toISOString() },
      { uuid: 'm2', sender: 'assistant', text: 'hi', createdAt: new Date(now + 100).toISOString() },
    ]);
    const dl = listenForDecision();

    const result = await processClaudeBody(CONV_ID, body, new ClaudeParser());

    expect(result.kind).toBe('downloaded');
    const decision = await dl.onceMatching((d) => d.conversationId === CONV_ID);
    expect(decision.action).toBe('downloaded');
    // sendMessage was invoked with a DOWNLOAD_REQUEST.
    expect(mock.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const arg = mock.runtime.sendMessage.mock.calls[0]![0] as { type: string; filename: string };
    expect(arg.type).toBe('DOWNLOAD_REQUEST');
    expect(arg.filename).toMatch(/\[claude\] Test Chat-11111111\.md$/);
    // Hash persisted.
    const hashes = mock.storage.local[HASH_KEY] as Record<string, string>;
    expect(hashes[CONV_ID]).toBeDefined();
  });

  it('skips with action=skipped:date when nothing is in range', async () => {
    const yesterday = Date.now() - 1000 * 60 * 60 * 30;
    const body = makeBody([
      { uuid: 'm1', sender: 'human', text: 'old', createdAt: new Date(yesterday).toISOString() },
    ]);
    const dl = listenForDecision();

    const result = await processClaudeBody(CONV_ID, body, new ClaudeParser());

    expect(result.kind).toBe('skipped');
    const decision = await dl.onceMatching((d) => d.conversationId === CONV_ID);
    expect(decision.action).toBe('skipped:date');
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('skips with action=skipped:hash when content is unchanged from a previous download', async () => {
    const now = Date.now();
    const body = makeBody([
      { uuid: 'm1', sender: 'human', text: 'hello', createdAt: new Date(now).toISOString() },
    ]);

    // First call writes a hash.
    await processClaudeBody(CONV_ID, body, new ClaudeParser());
    expect(mock.runtime.sendMessage).toHaveBeenCalledTimes(1);
    mock.runtime.sendMessage.mockClear();

    const dl = listenForDecision();
    const result = await processClaudeBody(CONV_ID, body, new ClaudeParser());

    expect(result.kind).toBe('skipped');
    const decision = await dl.onceMatching((d) => d.conversationId === CONV_ID);
    expect(decision.action).toBe('skipped:hash');
    expect(mock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('skips with action=skipped:other when the parser returns null (wrong shape)', async () => {
    const dl = listenForDecision();
    const result = await processClaudeBody(CONV_ID, { not: 'a conversation' }, new ClaudeParser());
    expect(result.kind).toBe('skipped');
    const decision = await dl.onceMatching((d) => d.conversationId === CONV_ID);
    expect(decision.action).toBe('skipped:other');
    expect(decision.reason).toMatch(/parser/);
  });
});

describe('processClaudeChatById', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock({ manifest: { host_permissions: ['https://claude.ai/*'] } });
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('discovers the org id once, caches it, and fetches the conversation', async () => {
    mock.storage.local[ORG_KEY] = undefined;

    const orgFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ uuid: 'org-uuid' }],
    })) as unknown as typeof fetch;
    const convFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        makeBody([
          { uuid: 'm1', sender: 'human', text: 'hi', createdAt: new Date().toISOString() },
        ]),
    })) as unknown as typeof fetch;

    let calls = 0;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (typeof url === 'string' && url.endsWith('/api/organizations')) {
        return (orgFetch as unknown as (...args: unknown[]) => Promise<Response>)(url, init);
      }
      return (convFetch as unknown as (...args: unknown[]) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const result = await processClaudeChatById(CONV_ID, new ClaudeParser(), { fetchImpl });
    expect(result.kind).toBe('downloaded');
    expect(calls).toBe(2); // org discovery + conversation
    expect(mock.storage.local[ORG_KEY]).toBe('org-uuid');
  });

  it('reuses cached org id without re-fetching /api/organizations', async () => {
    mock.storage.local[ORG_KEY] = 'cached-org';

    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/organizations')) {
        throw new Error('should not have called organizations endpoint');
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          makeBody([
            { uuid: 'm1', sender: 'human', text: 'hi', createdAt: new Date().toISOString() },
          ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await processClaudeChatById(CONV_ID, new ClaudeParser(), { fetchImpl });
    expect(result.kind).toBe('downloaded');
  });

  it('returns kind=error when org discovery fails', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await processClaudeChatById(CONV_ID, new ClaudeParser(), { fetchImpl });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.reason).toMatch(/org id/);
  });

  it('returns kind=error when the conversation fetch is non-ok', async () => {
    mock.storage.local[ORG_KEY] = 'org-uuid';
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/chat_conversations/')) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [{ uuid: 'org-uuid' }] } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await processClaudeChatById(CONV_ID, new ClaudeParser(), { fetchImpl });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.reason).toMatch(/404/);
  });
});
