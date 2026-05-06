// Shared implementation for SW + popup console forwarders.
//
// NOT used by the content-script forwarder — content scripts are classic
// scripts that can't load Rollup chunks, so they keep an inlined copy in
// `./content/index.ts` to avoid a shared chunk being created when both
// content and popup import this file.

const DEFAULT_SERVER = 'http://127.0.0.1:9876';

let installed = false;

export function installDirectForwarder(opts: {
  source: string;
  serverUrl?: string;
}): void {
  if (installed) return;
  installed = true;
  const url = `${(opts.serverUrl ?? DEFAULT_SERVER).replace(/\/$/, '')}/log`;
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void postLog(url, opts.source, level, args);
    };
  }
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (ev: ErrorEvent) => {
      void postLog(url, opts.source, 'error', [
        'unhandled error:',
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
      ]);
    });
    self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      void postLog(url, opts.source, 'error', ['unhandled rejection:', ev.reason]);
    });
  }
}

/** Used by popup (which can't reach localhost cross-origin in MV3
 *  without host_permissions, but the SW can — popup hands every log to
 *  the SW via runtime.sendMessage with type '__DEV_LOG__'). */
export function installRelayedForwarder(opts: { source: string }): void {
  if (installed) return;
  installed = true;
  const levels = ['log', 'info', 'warn', 'error'] as const;
  for (const level of levels) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void relayLog(opts.source, level, args);
    };
  }
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (ev: ErrorEvent) => {
      void relayLog(opts.source, 'error', [
        'unhandled error:',
        ev.message,
        ev.filename,
        ev.lineno,
        ev.colno,
      ]);
    });
    self.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      void relayLog(opts.source, 'error', ['unhandled rejection:', ev.reason]);
    });
  }
}

async function postLog(
  url: string,
  source: string,
  level: 'log' | 'info' | 'warn' | 'error',
  args: unknown[],
): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        level,
        args: args.map(serialise),
        ts: Date.now(),
      }),
    });
  } catch {
    /* server down — silent */
  }
}

async function relayLog(
  source: string,
  level: 'log' | 'info' | 'warn' | 'error',
  args: unknown[],
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: '__DEV_LOG__',
      payload: JSON.stringify({
        source,
        level,
        args: args.map(serialise),
        ts: Date.now(),
      }),
    });
  } catch {
    /* extension context invalidated — silent */
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
