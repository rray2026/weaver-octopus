# @weaver-octopus/ext-dev-rpc

Sidecar **RPC for driving a running Chrome extension from the terminal**:

- ⚡ **Hot-reload** — every Vite rebuild reloads the extension and refreshes
  matched tabs automatically. No more `↺` clicks.
- 📜 **Console log forwarding** — `console.log/info/warn/error` from the
  service worker, popup and content scripts streams into a local
  `.dev-runtime.log` file as JSONL. `tail -F` it from another terminal,
  read it from your AI assistant — no DevTools required.
- 🎯 **Scenario commands** — push a JSON action to `localhost:9876` and the
  extension runs your handler. Drive any specific feature without
  clicking through the popup UI.

The package is **production-zero-cost** — it expects you to gate its
calls with a compile-time constant (e.g. `__EXT_DEV__`) so Rollup
tree-shakes the entire surface in your shipping bundle.

## Why this exists when wxt / plasmo etc. exist

Those frameworks rebuild your extension from scratch. This package is
**additive** — drop it into an existing MV3 extension as a workspace
package, gate it with one `if` block in your background entry, and you
get a CLI-friendly debug loop that survives system idle, log forwarding
that survives DevTools being closed, and scenario triggers that work on
**your already-logged-in Chrome session** (rather than a Playwright
puppet).

## Install (workspace example)

```jsonc
// apps/your-extension/package.json
{
  "dependencies": {
    "@weaver-octopus/ext-dev-rpc": "workspace:*"
  }
}
```

## Wiring — three places

### 1. Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { extDevRpcPlugin } from '@weaver-octopus/ext-dev-rpc/vite';

const isDev = process.env.MY_APP_DEV === '1';

export default defineConfig({
  define: {
    __EXT_DEV__: JSON.stringify(isDev),
  },
  plugins: [
    ...extDevRpcPlugin({ enabled: isDev }),
  ],
  // ...
});
```

The plugin emits `dist/build_id.txt` on every rebuild and patches the
built `dist/manifest.json` to add `http://127.0.0.1/*` and
`http://localhost/*` host permissions (so the SW can fetch the dev
sidecar). Both side-effects only fire when `enabled: true`.

### 2. Background service worker

```ts
// src/background/index.ts
import { startDevServer } from '@weaver-octopus/ext-dev-rpc/background';

declare const __EXT_DEV__: boolean; // injected via vite.define

if (__EXT_DEV__) {
  startDevServer({
    source: 'background',
    handlers: {
      'reset-cache': async () => {
        await chrome.storage.local.clear();
        return { cleared: true };
      },
      'open-tab': async (cmd) =>
        chrome.tabs.create({ url: cmd.url as string, active: true }),
      'my-action': async (cmd) => {
        // call into your app code
      },
    },
  });
}
```

That single call wires:
- console forwarding (this SW's logs)
- relay for popup/content `__DEV_LOG__` messages
- auto-reload poller (`build_id.txt` watcher)
- 30s `chrome.alarms` keepalive (survives system idle)
- long-poll `/command` queue with your handlers

### 3. Popup + content scripts

```ts
// popup entry
import { startDevForwarder } from '@weaver-octopus/ext-dev-rpc/popup';
declare const __EXT_DEV__: boolean;
if (__EXT_DEV__) startDevForwarder('popup');
```

```ts
// content script entry
import { startDevForwarder } from '@weaver-octopus/ext-dev-rpc/content';
declare const __EXT_DEV__: boolean;
if (__EXT_DEV__) startDevForwarder(`content:${location.hostname}`);
```

(Two distinct entry points because **content scripts are classic
scripts that can't load Rollup chunks**. The content forwarder is a
self-contained file with zero shared imports so Rollup never splits it
out.)

## Run the sidecar

```bash
# In the consumer's package.json scripts:
{
  "dev:hot": "MY_APP_DEV=1 vite build --watch",
  "dev:logs": "ext-dev-rpc-server",
  "dev:trigger": "ext-dev-rpc-trigger"
}
```

```bash
# Terminal A — vite watch
pnpm dev:hot

# Terminal B — log file appears here
pnpm dev:logs
# > [dev-log-server] listening on http://127.0.0.1:9876
# > [dev-log-server] log file: <cwd>/.dev-runtime.log

# Terminal C — drive scenarios
pnpm dev:trigger '{"action":"reset-cache"}'
echo '{"action":"open-tab","url":"https://example.com"}' | pnpm dev:trigger

# Terminal D — watch logs
tail -F .dev-runtime.log
```

## Log file format

JSONL, one record per `console.*` call:

```json
{"source":"background","level":"log","args":["[my-app] hello",{"foo":1}],"ts":1730000000000}
{"source":"content:gemini.google.com","level":"warn","args":["selector miss"],"ts":1730000000123}
```

Filter by source / level with `grep` or `jq`. `Error` instances are
serialised to `{__type:"Error", name, message, stack}`.

## Server endpoints

| Verb | Path | Purpose |
|---|---|---|
| POST | /log | Append a log line. Body: `{source, level, args, ts}`. |
| POST | /command | Enqueue a command. Body: `{action, ...}`. Wakes any waiting long-poll. |
| GET | /command | Long-poll up to 25s. 200 + JSON when a command arrives, 204 on timeout. |
| GET | /status | `{ok, startedAt, logCount, queuedCommands, logPath}`. |

## SW keepalive caveat

MV3 service workers idle out after ~30s of inactivity. This package
combines two layers:

1. **Long-poll fetch** to `/command` (in-flight fetch counts as activity).
2. **30s `chrome.alarms`** — alarms persist across SW deaths and re-boot
   the SW; the no-op handler reruns module top-level which restarts the
   long-poll.

That covers normal use. **Deep system idle** (laptop sleep / suspend)
can still kill both layers; recovery is manual:
- click `Service Worker` link in `chrome://extensions`, OR
- open the popup, OR
- refresh any tab matched by `host_permissions`.

The dev sidecar prints a warning once per minute if it hasn't received
a long-poll for 90s.

## Production zero-cost

The package is implemented so that:

```ts
if (__EXT_DEV__) startDevServer({...});
```

becomes (after `__EXT_DEV__ = false`):

```ts
if (false) startDevServer({...});
```

which Rollup eliminates entirely — including the import statement.
Verified in our own consumer:

| Build | `background.js` | `chunks/` |
|---|---|---|
| `MY_APP_DEV=1 vite build` | 26 kB | yes |
| `vite build` (default) | 16 kB | none |

## Provenance

Extracted from
[weaver-octopus](https://github.com/rray2026/weaver-octopus) where it was
built incrementally to debug a Chrome extension capturing Claude/Gemini
chats. The README's terminology ("backfill", "claude-fetch") leaks
through because the package was born inside that codebase.
