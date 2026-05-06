// Long-poll /command on the dev-log-server. SW issues a fetch with no
// short timeout; the server holds it up to 25s, returns 204 if no
// command arrives, or 200 + JSON the moment one is queued. We
// immediately re-issue. The in-flight fetch counts as SW activity and
// keeps the worker alive between commands.

import type { DevCommand, DevCommandHandler } from '../types.js';

const ERROR_BACKOFF_MS = 2_000;
const DEFAULT_SERVER = 'http://127.0.0.1:9876';

let started = false;

export function startCommandPoller(opts: {
  handlers: Record<string, DevCommandHandler>;
  serverUrl?: string;
  tag?: string;
}): void {
  if (started) return;
  started = true;
  const tag = opts.tag ?? '[ext-dev-rpc:cmd]';
  const url = `${(opts.serverUrl ?? DEFAULT_SERVER).replace(/\/$/, '')}/command`;
  console.log(tag, 'long-poll loop started');
  void runLoop(url, opts.handlers, tag);
}

async function runLoop(
  pollUrl: string,
  handlers: Record<string, DevCommandHandler>,
  tag: string,
): Promise<void> {
  while (true) {
    let cmd: DevCommand | null = null;
    try {
      const res = await fetch(pollUrl, { cache: 'no-store' });
      if (res.status === 204) continue;
      if (!res.ok) {
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      cmd = (await res.json()) as DevCommand;
    } catch {
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (!cmd || typeof cmd !== 'object' || !cmd.action) continue;
    console.log(tag, 'received', cmd);
    const handler = handlers[cmd.action];
    if (!handler) {
      console.warn(tag, 'no handler for action', cmd.action);
      continue;
    }
    try {
      const result = await handler(cmd);
      console.log(tag, cmd.action, result);
    } catch (err) {
      console.error(tag, 'handler threw', { cmd, err });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
