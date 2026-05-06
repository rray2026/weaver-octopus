// Content-script-only console forwarder.
//
// **Self-contained on purpose.** Content scripts in MV3 are classic
// scripts that can't load Rollup chunks. If this file imported a
// shared module that the popup also imports, Rollup would split it
// into a chunk and the consumer's content.js would carry an `import`
// statement that fails at runtime. Keep this file source-of-truth-ish
// — duplicates ~30 lines from `_log-forwarder-impl.ts`.

let installed = false;

/** Wraps console.log/info/warn/error and ships each call to the
 *  background SW via chrome.runtime.sendMessage with type '__DEV_LOG__'.
 *  The background's startDevServer relays it to the local dev-log-server.
 *
 *  `source` is recorded on each log line so a log file from many tabs
 *  can be filtered (e.g. 'content:claude.ai', 'content:gemini.google.com').
 */
export function startDevForwarder(source: string): void {
  if (installed) return;
  installed = true;
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      relay(source, level, args);
    };
  }
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (ev: ErrorEvent) => {
      relay(source, 'error', [
        'unhandled error:',
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
      ]);
    });
    self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      relay(source, 'error', ['unhandled rejection:', ev.reason]);
    });
  }
}

function relay(
  source: string,
  level: 'log' | 'info' | 'warn' | 'error',
  args: unknown[],
): void {
  try {
    chrome.runtime
      .sendMessage({
        type: '__DEV_LOG__',
        payload: JSON.stringify({
          source,
          level,
          args: args.map(serialise),
          ts: Date.now(),
        }),
      })
      .catch(() => undefined);
  } catch {
    /* extension context invalidated */
  }
}

function serialise(v: unknown): unknown {
  if (v instanceof Error) {
    return { __type: 'Error', name: v.name, message: v.message, stack: v.stack };
  }
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
