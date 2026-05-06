// Public API for the background service worker.
//
// One call wires up everything:
//   - console.* forwarding to the dev-log-server (this SW)
//   - chrome.runtime.sendMessage relay for popup/content __DEV_LOG__ messages
//   - auto-reload poller that watches dist/build_id.txt
//   - chrome.alarms 30s keepalive
//   - long-poll command queue with user-supplied action handlers
//
// Usage:
//   import { startDevServer } from '@weaver-octopus/ext-dev-rpc/background';
//
//   declare const __EXT_DEV__: boolean;
//   if (__EXT_DEV__) {
//     startDevServer({
//       source: 'background',
//       handlers: {
//         'reset-cache': () => chrome.storage.local.clear(),
//         'open': (cmd) => chrome.tabs.create({ url: cmd.url as string }),
//       },
//     });
//   }
//
// The whole module is dead-code-eliminated when __EXT_DEV__ is false at
// the call site (Rollup folds the import out alongside the function call).

import { installDirectForwarder } from '../_log-forwarder-impl.js';
import type { DevCommandHandler, DevServerEndpoints } from '../types.js';
import { onInstalledRefreshTabs, startAutoReload } from './auto-reload.js';
import { startCommandPoller } from './command-poller.js';

export interface StartDevServerOptions extends DevServerEndpoints {
  /** Source label recorded on each forwarded log line. Convention: 'background'. */
  source?: string;
  /** Action → handler map. The handler receives the raw command JSON. */
  handlers: Record<string, DevCommandHandler>;
  /** Set to false to disable a specific subsystem (rare). */
  features?: {
    autoReload?: boolean;
    forwarder?: boolean;
    commandPoller?: boolean;
    devLogRelay?: boolean;
  };
  /** Optional log tag prefix (default '[ext-dev-rpc]'). */
  tag?: string;
}

let started = false;

export function startDevServer(opts: StartDevServerOptions): void {
  if (started) return;
  started = true;
  const tag = opts.tag ?? '[ext-dev-rpc]';
  const source = opts.source ?? 'background';
  const features = {
    autoReload: opts.features?.autoReload ?? true,
    forwarder: opts.features?.forwarder ?? true,
    commandPoller: opts.features?.commandPoller ?? true,
    devLogRelay: opts.features?.devLogRelay ?? true,
  };

  if (features.forwarder) {
    installDirectForwarder({ source, serverUrl: opts.serverUrl });
  }
  if (features.devLogRelay) {
    installDevLogRelay(opts.serverUrl);
  }
  if (features.autoReload) {
    startAutoReload({ tag: `${tag}[auto-reload]` });
    chrome.runtime.onInstalled.addListener(() => {
      void onInstalledRefreshTabs({ tag: `${tag}[auto-reload]` });
    });
  }
  if (features.commandPoller) {
    startCommandPoller({
      handlers: opts.handlers,
      serverUrl: opts.serverUrl,
      tag: `${tag}[cmd]`,
    });
  }
}

/** Listens for `{type: '__DEV_LOG__', payload: <stringified-json>}` messages
 *  from popup/content forwarders and POSTs them to the dev-log-server. */
function installDevLogRelay(serverUrl: string | undefined): void {
  const url = `${(serverUrl ?? 'http://127.0.0.1:9876').replace(/\/$/, '')}/log`;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as { type?: string }).type !== '__DEV_LOG__'
    ) {
      return undefined;
    }
    const payload = (message as { payload?: string }).payload;
    if (typeof payload === 'string') {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }).catch(() => undefined);
    }
    sendResponse({ ok: true });
    return false;
  });
}

export type { DevCommand, DevCommandHandler, DevCommandResult } from '../types.js';
