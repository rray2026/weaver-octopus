import { installRelayedForwarder } from '../_log-forwarder-impl.js';

/** Wraps console.log/info/warn/error in the popup and routes each call
 *  through the background SW (which then POSTs to the dev-log-server).
 *  Popup runs in a chrome-extension://… origin and can't reach
 *  http://localhost from MV3 directly. Relay via SW is the safe path. */
export function startDevForwarder(source: string): void {
  installRelayedForwarder({ source });
}
