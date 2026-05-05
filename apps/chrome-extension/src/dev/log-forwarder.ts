// Dev-only console forwarder.
//
// Wraps console.log/info/warn/error so each call is mirrored to the
// localhost:9876 dev-log-server (started via `pnpm dev:logs`). The original
// console call still happens, so DevTools shows everything as before.
//
// In production builds __WEAVER_DEV__ is false and the entire module is
// dead-code-eliminated by Rollup (every importer guards `startDevLogForwarder`
// with the const).

const DEV_SERVER_URL = 'http://127.0.0.1:9876/log';

let installed = false;

/** Idempotent. `source` is recorded with each line so the receiver can
 *  distinguish 'background' vs 'content:claude.ai' vs 'popup' etc. */
export function startDevLogForwarder(source: string): void {
  if (installed) return;
  installed = true;
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void send(source, level, args);
    };
  }
  // Surface unhandled errors as well (very useful in content scripts where
  // the user might not have DevTools open on that frame).
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (ev: ErrorEvent) => {
      void send(source, 'error', [
        'unhandled error:',
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
      ]);
    });
    self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      void send(source, 'error', ['unhandled rejection:', ev.reason]);
    });
  }
}

async function send(
  source: string,
  level: 'log' | 'info' | 'warn' | 'error',
  args: unknown[],
): Promise<void> {
  const payload = JSON.stringify({
    source,
    level,
    args: args.map(serialiseArg),
    ts: Date.now(),
  });
  const isServiceWorker = typeof window === 'undefined';
  if (isServiceWorker) {
    // SW has cross-origin fetch via host_permissions. Send directly.
    try {
      await fetch(DEV_SERVER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
    } catch {
      /* dev server not running — silent */
    }
  } else {
    // Content scripts and popup can't reliably fetch http://localhost in MV3
    // (CORS / extension fetch quirks). Route through the background SW which
    // does have the host permission.
    try {
      await chrome.runtime.sendMessage({ type: '__DEV_LOG__', payload });
    } catch {
      /* extension context invalidated, or no listener — silent */
    }
  }
}

function serialiseArg(v: unknown): unknown {
  if (v instanceof Error) {
    return { __type: 'Error', name: v.name, message: v.message, stack: v.stack };
  }
  // Primitive values pass through. Objects: try structured clone via JSON
  // round-trip. If it fails (cycles, DOM nodes, …) fall back to a string.
  try {
    JSON.stringify(v);
    return v;
  } catch {
    try {
      return String(v);
    } catch {
      return '<unserialisable>';
    }
  }
}
