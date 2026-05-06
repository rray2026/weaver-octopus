#!/usr/bin/env node
// @weaver-octopus/ext-dev-rpc — dev sidecar HTTP server.
//
// Endpoints:
//   POST /log       body = JSON {source, level, args, ts} → append to log file
//   POST /command   body = JSON {action, ...}             → push onto FIFO queue
//   GET  /command   → long-poll, hold up to 25s for a queued command
//   GET  /status    → server stats
//
// All endpoints set `Access-Control-Allow-Origin: *` so the extension
// can fetch them from its SW (with the localhost host_permission).
//
// Defaults:
//   port      9876  (override: EXT_DEV_RPC_PORT)
//   log file  ./.dev-runtime.log relative to cwd  (override: EXT_DEV_RPC_LOG_PATH)

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const LOG_PATH = resolve(
  process.env.EXT_DEV_RPC_LOG_PATH ??
    process.env.WEAVER_DEV_LOG_PATH ?? // backward-compat alias
    './.dev-runtime.log',
);
const PORT = Number(
  process.env.EXT_DEV_RPC_PORT ?? process.env.WEAVER_DEV_PORT ?? 9876,
);

mkdirSync(dirname(LOG_PATH), { recursive: true });

/** @type {Array<Record<string, unknown>>} */
const commandQueue = [];
/** @type {Array<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout}>} */
const longPollWaiters = [];
const LONG_POLL_TIMEOUT_MS = 25_000;
// Health watchdog: if no client has long-polled /command for this long, the
// SW is almost certainly asleep. Print a one-line warning per minute so the
// dev notices instead of silently waiting on `dev:trigger` round-trips that
// will never complete.
const SW_HEARTBEAT_GRACE_MS = 90_000;
const SW_HEARTBEAT_WARN_INTERVAL_MS = 60_000;
let logCount = 0;
let lastLongPollAt = Date.now();
let lastWarnAt = 0;
const startedAt = Date.now();

function deliverNext() {
  while (longPollWaiters.length > 0 && commandQueue.length > 0) {
    const waiter = longPollWaiters.shift();
    const cmd = commandQueue.shift();
    if (!waiter || !cmd) continue;
    clearTimeout(waiter.timer);
    try {
      waiter.res.writeHead(200, {
        'content-type': 'application/json',
        ...corsHeaders(),
      });
      waiter.res.end(JSON.stringify(cmd));
    } catch {
      // client gone — push the command back for the next waiter
      commandQueue.unshift(cmd);
    }
  }
}

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
      // Wake any long-pollers immediately so the SW gets the command in
      // milliseconds rather than waiting up to LONG_POLL_TIMEOUT_MS.
      deliverNext();
      res.writeHead(202, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ ok: true, queued: parsed }));
      return;
    }

    if (req.method === 'GET' && req.url === '/command') {
      // Long-poll: hold the request open until a command arrives, then
      // return it. If nothing arrives in LONG_POLL_TIMEOUT_MS, return 204.
      // This keeps the extension's MV3 service worker alive — SWs are
      // killed after 30s idle, but an in-flight fetch counts as activity.
      lastLongPollAt = Date.now();
      if (commandQueue.length > 0) {
        const next = commandQueue.shift();
        res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify(next));
        return;
      }
      const timer = setTimeout(() => {
        const idx = longPollWaiters.findIndex((w) => w.res === res);
        if (idx >= 0) longPollWaiters.splice(idx, 1);
        try {
          res.writeHead(204, corsHeaders());
          res.end();
        } catch {
          /* connection already closed */
        }
      }, LONG_POLL_TIMEOUT_MS);
      const waiter = { res, timer };
      longPollWaiters.push(waiter);
      // If the client disconnects (e.g. SW reloaded), drop the waiter.
      req.on('close', () => {
        clearTimeout(timer);
        const idx = longPollWaiters.indexOf(waiter);
        if (idx >= 0) longPollWaiters.splice(idx, 1);
      });
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

// SW health watchdog: warn once per minute if the SW hasn't long-polled
// /command for SW_HEARTBEAT_GRACE_MS. Doesn't fix anything, but turns
// "dev:trigger silent" into "obvious diagnostic line in dev:logs terminal".
setInterval(() => {
  const idleMs = Date.now() - lastLongPollAt;
  if (idleMs < SW_HEARTBEAT_GRACE_MS) return;
  if (Date.now() - lastWarnAt < SW_HEARTBEAT_WARN_INTERVAL_MS) return;
  lastWarnAt = Date.now();
  console.warn(
    `[dev-log-server] WARNING: no SW long-poll for ${Math.round(idleMs / 1000)}s — extension service worker may be asleep. Wake it: chrome://extensions → Weaver Octopus → Service Worker link, OR refresh claude.ai / gemini.google.com tab.`,
  );
}, 15_000);
