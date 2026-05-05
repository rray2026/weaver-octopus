#!/usr/bin/env node
// Dev sidecar: HTTP loopback server that the extension's hot-reload build
// posts logs and pulls scenario commands from. Append-only log file lives at
// `apps/chrome-extension/.dev-runtime.log` so Claude Code (or `tail -F`) can
// observe the running extension without DevTools.
//
// Endpoints:
//   POST /log       body = JSON {source, level, args, ts} → append to log file
//   POST /command   body = JSON {action, ...}             → push onto FIFO queue
//   GET  /command   → pop next command (or 204 if empty)
//   GET  /status    → returns server stats
//
// All endpoints respond with `Access-Control-Allow-Origin: *` so the
// extension can call them with credentials:'omit'.

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH =
  process.env.WEAVER_DEV_LOG_PATH ?? resolve(__dirname, '..', '.dev-runtime.log');
const PORT = Number(process.env.WEAVER_DEV_PORT ?? 9876);

mkdirSync(dirname(LOG_PATH), { recursive: true });

/** @type {Array<Record<string, unknown>>} */
const commandQueue = [];
let logCount = 0;
const startedAt = Date.now();

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

async function readBody(req) {
  return new Promise((resolveRead, rejectRead) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveRead(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', rejectRead);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    if (req.method === 'POST' && req.url === '/log') {
      const body = await readBody(req);
      // Expected JSON shape: {source, level, args, ts}.
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { raw: body };
      }
      const ts = parsed.ts ?? Date.now();
      const line = JSON.stringify({ ...parsed, ts }) + '\n';
      appendFileSync(LOG_PATH, line);
      logCount++;
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: `bad JSON: ${String(err)}` }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.action) {
        res.writeHead(400, { 'content-type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: 'missing "action"' }));
        return;
      }
      commandQueue.push(parsed);
      console.log('[dev-log-server] queued command', parsed);
      res.writeHead(202, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true, queued: parsed }));
      return;
    }

    if (req.method === 'GET' && req.url === '/command') {
      const next = commandQueue.shift();
      if (!next) {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify(next));
      return;
    }

    if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(
        JSON.stringify({
          ok: true,
          startedAt,
          logCount,
          queuedCommands: commandQueue.length,
          logPath: LOG_PATH,
        }),
      );
      return;
    }

    res.writeHead(404, corsHeaders());
    res.end();
  } catch (err) {
    console.error('[dev-log-server] handler threw', err);
    try {
      res.writeHead(500, corsHeaders());
      res.end(String(err));
    } catch {
      /* ignore */
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-log-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[dev-log-server] log file: ${LOG_PATH}`);
  console.log('[dev-log-server] tail with: tail -F', LOG_PATH);
});
