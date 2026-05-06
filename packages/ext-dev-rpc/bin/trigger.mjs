#!/usr/bin/env node
// @weaver-octopus/ext-dev-rpc — queue a scenario command on the dev
// sidecar. The extension's background SW long-polls /command and runs
// the matching handler.
//
// Action set is **defined by the consumer** (in startDevServer's
// `handlers` map). This CLI only ferries JSON; payloads are opaque.
//
// Usage (positional JSON):
//   ext-dev-rpc-trigger '{"action":"reset-cache"}'
//
// Or piped via stdin:
//   echo '{"action":"open","url":"https://example.com"}' | ext-dev-rpc-trigger

import http from 'node:http';

const PORT = Number(
  process.env.EXT_DEV_RPC_PORT ?? process.env.WEAVER_DEV_PORT ?? 9876,
);

async function readStdin() {
  return new Promise((resolveRead, rejectRead) => {
    if (process.stdin.isTTY) return resolveRead('');
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () =>
      resolveRead(Buffer.concat(chunks).toString('utf-8')),
    );
    process.stdin.on('error', rejectRead);
  });
}

async function main() {
  const arg = process.argv.slice(2).join(' ').trim();
  const stdin = (await readStdin()).trim();
  const raw = arg || stdin;
  if (!raw) {
    console.error(
      'usage: dev-trigger \'<json>\'  or  echo \'<json>\' | dev-trigger',
    );
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('not valid JSON:', err.message);
    console.error('input was:', raw);
    process.exit(2);
  }
  const body = JSON.stringify(payload);

  await new Promise((resolveRequest, rejectRequest) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/command',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            console.error(`HTTP ${res.statusCode}:`, text);
            process.exit(1);
          }
          console.log(`HTTP ${res.statusCode}:`, text);
          resolveRequest();
        });
      },
    );
    req.on('error', (err) => {
      console.error(
        `couldn't reach dev server on :${PORT} — is \`pnpm dev:logs\` running?`,
      );
      console.error(err.message);
      rejectRequest(err);
    });
    req.write(body);
    req.end();
  });
}

main().catch(() => process.exit(1));
