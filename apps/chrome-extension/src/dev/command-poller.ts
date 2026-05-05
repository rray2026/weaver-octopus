// Dev-only command poller.
//
// Polls http://127.0.0.1:9876/command every few seconds. When the dev server
// returns a queued command (200 + JSON), executes it. Used by Claude Code
// (and the human) to drive specific scenarios without clicking through the
// popup UI:
//
//   pnpm dev:trigger '{"action":"start-backfill","providers":["claude"]}'
//
// chrome.runtime.sendMessage from the SW back to the SW's own listener
// isn't delivered, so action handlers are passed in via dependency
// injection from src/background/index.ts (where they're already defined).

const POLL_URL = 'http://127.0.0.1:9876/command';
const POLL_MS = 1500;
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
}

interface DevCommand {
  action: string;
  [key: string]: unknown;
}

let started = false;

export function startDevCommandPoller(handlers: DevCommandHandlers): void {
  if (started) return;
  started = true;
  console.log(TAG, 'poller started (every', POLL_MS, 'ms)');
  setInterval(() => {
    void poll(handlers);
  }, POLL_MS);
}

async function poll(handlers: DevCommandHandlers): Promise<void> {
  let cmd: DevCommand | null = null;
  try {
    const res = await fetch(POLL_URL, { cache: 'no-store' });
    if (res.status === 204) return;
    if (!res.ok) return;
    cmd = (await res.json()) as DevCommand;
  } catch {
    return; // dev server not running
  }
  if (!cmd || typeof cmd !== 'object' || !cmd['action']) return;
  console.log(TAG, 'received', cmd);
  try {
    await executeCommand(cmd, handlers);
  } catch (err) {
    console.error(TAG, 'command failed', { cmd, err });
  }
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
    default:
      console.warn(TAG, 'unknown action', cmd.action);
  }
}
