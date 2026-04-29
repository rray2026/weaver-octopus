// Lightweight stand-in for claude.ai that the e2e test points the extension at.
// Serves:
//   GET /                     → minimal HTML page (page sets document.title)
//   GET /api/organizations/<UUID>/chat_conversations/<UUID>
//                             → JSON shaped like Claude's real conversation API
//
// The intercept script's URL regex doesn't include the host — only the path
// shape — so as long as the path matches, it'll trigger the same code path
// that runs on production claude.ai.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { AddressInfo } from 'net';

export const ORG_UUID = '11111111-1111-1111-1111-111111111111';
export const CONV_UUID = '22222222-2222-2222-2222-222222222222';
export const CONV_UUID_B = '33333333-3333-3333-3333-333333333333';

export function conversationUrl(convId: string = CONV_UUID): string {
  return `/api/organizations/${ORG_UUID}/chat_conversations/${convId}`;
}

export function buildSampleConversation(name = 'E2E Sample', convId = CONV_UUID): unknown {
  const now = new Date().toISOString();
  return {
    uuid: convId,
    name,
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        created_at: now,
        content: [{ type: 'text', text: 'hello from e2e' }],
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: now,
        content: [{ type: 'text', text: 'hi back' }],
      },
    ],
  };
}

const PAGE_HTML = `<!doctype html>
<html><head><title>E2E Test - Claude</title></head>
<body>
<h1>E2E test page</h1>
<script>
  // Tests drive fetches via this helper rather than UI buttons so each test
  // can hit whatever URL it needs (conversation, non-conversation, etc).
  window.weaverFetch = async function (url) {
    const r = await fetch(url);
    return { ok: r.ok, status: r.status };
  };
</script>
</body></html>`;

export interface E2EServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<E2EServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    const convMatch = url.match(
      /^\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/([0-9a-f-]{36})$/,
    );
    if (convMatch) {
      const convId = convMatch[1]!;
      const name = convId === CONV_UUID_B ? 'E2E Sample B' : 'E2E Sample';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(buildSampleConversation(name, convId)));
      return;
    }
    // Non-conversation API endpoint: tests use this to verify the intercept
    // regex doesn't fire on unrelated requests.
    if (url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unrelated: true }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
