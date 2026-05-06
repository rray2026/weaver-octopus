// Content-script-only console forwarder.
//
// Wraps console.log/info/warn/error and ships each call to the background
// SW via chrome.runtime.sendMessage with type '__DEV_LOG__'. The background
// then POSTs to the localhost dev-log-server so Claude Code (and `tail -F`)
// can see content-script output without DevTools.
//
// Why this lives in src/content/ instead of reusing src/dev/log-forwarder.ts:
// content scripts are classic scripts (not modules) and can't load Rollup
// chunks. If both content and popup imported the shared forwarder, Rollup
// would split it into chunks/log-forwarder.js — and content.js's static
// `import` of that chunk would fail at runtime. Keeping a separate
// implementation here ensures Rollup keeps the forwarder inlined into
// content.js.
//
// In production builds __WEAVER_DEV__ is false; the entire module is
// dead-code-eliminated by Rollup (every importer guards the call with
// `if (__WEAVER_DEV__)`).

let installed = false;

export function startContentDevLogForwarder(source: string): void {
  if (installed) return;
  installed = true;
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      forward(source, level, args);
    };
  }
  // Also surface unhandled errors / rejections — content frames often
  // don't have DevTools open on the right tab.
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (ev: ErrorEvent) => {
      forward(source, 'error', [
        'unhandled error:',
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
      ]);
    });
    self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      forward(source, 'error', ['unhandled rejection:', ev.reason]);
    });
  }
}

function forward(
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
