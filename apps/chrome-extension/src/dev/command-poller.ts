// Dev-only command poller.
//
// Issues a long-poll GET to http://127.0.0.1:9876/command. The dev server
// holds the request open until a command is queued (or ~25s elapses), then
// returns it; we execute and immediately re-issue. This serves two
// purposes: instant command delivery (no 1.5s polling lag), AND keeping
// the MV3 service worker alive — SWs are killed after 30s idle, but an
// in-flight fetch counts as activity, so the loop is self-sustaining.
//
// On any error (server down, network glitch) we back off briefly and
// retry; the SW may then go idle, but the next event (alarm, message,
// fetch from the auto-reload poller) re-enters this loop.
//
// chrome.runtime.sendMessage from the SW back to the SW's own listener
// isn't delivered, so action handlers are passed in via dependency
// injection from src/background/index.ts.

const POLL_URL = 'http://127.0.0.1:9876/command';
const ERROR_BACKOFF_MS = 2_000;
const TAG = '[weaver:dev-cmd]';

export interface DevCommandHandlers {
  startBackfill: (opts: {
    providers: Array<'claude' | 'gemini'>;
    intervalMinSec?: number;
    intervalMaxSec?: number;
  }) => Promise<unknown> | unknown;
  stopBackfill: () => Promise<unknown> | unknown;
  resetCache: () => Promise<unknown> | unknown;
  setClaudeMode: (mode: 'intercept' | 'fetch') => Promise<unknown> | unknown;
  openTab: (url: string) => Promise<unknown> | unknown;
  reloadExtension: () => void;
  /** Read selected (or all) keys from chrome.storage.local and log them. */
  dumpStorage: (keys?: string[]) => Promise<unknown> | unknown;
}

interface DevCommand {
  action: string;
  [key: string]: unknown;
}

let started = false;

export function startDevCommandPoller(handlers: DevCommandHandlers): void {
  if (started) return;
  started = true;
  console.log(TAG, 'long-poll loop started');
  void runLoop(handlers);
}

async function runLoop(handlers: DevCommandHandlers): Promise<void> {
  // Tight loop: each iteration is either an in-flight long-poll fetch
  // (server holds it for ~25s) or a brief sleep on error. Either way,
  // the SW has activity and won't be killed.
  while (true) {
    let cmd: DevCommand | null = null;
    try {
      const res = await fetch(POLL_URL, { cache: 'no-store' });
      if (res.status === 204) {
        // Server timed out without a command — re-loop immediately.
        continue;
      }
      if (!res.ok) {
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      cmd = (await res.json()) as DevCommand;
    } catch {
      // Server down or fetch aborted (e.g. SW being torn down).
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (!cmd || typeof cmd !== 'object' || !cmd['action']) continue;
    console.log(TAG, 'received', cmd);
    try {
      await executeCommand(cmd, handlers);
    } catch (err) {
      console.error(TAG, 'command failed', { cmd, err });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeCommand(
  cmd: DevCommand,
  handlers: DevCommandHandlers,
): Promise<void> {
  switch (cmd.action) {
    case 'start-backfill': {
      const rawProviders = Array.isArray(cmd['providers'])
        ? (cmd['providers'] as unknown[])
        : ['claude', 'gemini'];
      const providers = rawProviders.filter(
        (p): p is 'claude' | 'gemini' => p === 'claude' || p === 'gemini',
      );
      const result = await handlers.startBackfill({
        providers,
        intervalMinSec:
          typeof cmd['intervalMinSec'] === 'number'
            ? (cmd['intervalMinSec'] as number)
            : undefined,
        intervalMaxSec:
          typeof cmd['intervalMaxSec'] === 'number'
            ? (cmd['intervalMaxSec'] as number)
            : undefined,
      });
      console.log(TAG, 'start-backfill →', result);
      return;
    }
    case 'stop-backfill': {
      const result = await handlers.stopBackfill();
      console.log(TAG, 'stop-backfill →', result);
      return;
    }
    case 'reset-cache': {
      await handlers.resetCache();
      console.log(TAG, 'reset-cache done');
      return;
    }
    case 'set-claude-mode': {
      const mode = cmd['mode'];
      if (mode !== 'intercept' && mode !== 'fetch') {
        console.warn(TAG, 'invalid mode for set-claude-mode', mode);
        return;
      }
      await handlers.setClaudeMode(mode);
      console.log(TAG, 'set-claude-mode →', mode);
      return;
    }
    case 'open': {
      const url = cmd['url'];
      if (typeof url !== 'string') {
        console.warn(TAG, 'open: expected string url', cmd);
        return;
      }
      await handlers.openTab(url);
      console.log(TAG, 'open →', url);
      return;
    }
    case 'reload': {
      console.log(TAG, 'forcing chrome.runtime.reload()');
      handlers.reloadExtension();
      return;
    }
    case 'dump-storage': {
      const keys = Array.isArray(cmd['keys']) ? (cmd['keys'] as string[]) : undefined;
      const result = await handlers.dumpStorage(keys);
      console.log(TAG, 'dump-storage', result);
      return;
    }
    default:
      console.warn(TAG, 'unknown action', cmd.action);
  }
}
