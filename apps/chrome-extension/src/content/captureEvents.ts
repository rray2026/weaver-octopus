// In-tab signalling between the passive orchestrators and the active
// backfill runner.
//
// The orchestrator never knows whether anyone is listening — it just dispatches
// a CustomEvent on `window` after each capture decision (download / skip
// reason). The backfill runner subscribes during a backfill so it can
// short-circuit the per-chat timeout when the orchestrator has already made
// up its mind (e.g. "no messages in date range" decided synchronously after
// the API response — typically <1s after navigation, vs. the runner's 20s
// fallback timeout).
//
// Outside backfill no one listens, so the events are no-op observers.

import type { Provider } from '../types/index.js';

export type CaptureAction =
  | 'downloaded'
  | 'skipped:date'         // outside the active date filter range — older than range.start
  | 'skipped:date:newer'   // outside the active date filter range — newer than range.end
                           // (sidebar is date-sorted newest-first, so newer chats come BEFORE
                           // in-range ones; runner must keep walking, not early-stop)
  | 'skipped:hash'         // identical content already downloaded
  | 'skipped:empty'        // parser found no messages / no turns
  | 'skipped:other';       // anything else (parser-null, race)

export interface CaptureDecisionDetail {
  provider: Provider;
  conversationId: string;
  action: CaptureAction;
  /** Optional human-readable reason — surfaced in the backfill log. */
  reason?: string;
}

export const CAPTURE_DECISION_EVENT = 'weaver-octopus:capture-decision';

/** Fire-and-forget broadcast. Errors are swallowed (the orchestrator must
 *  never fail because of telemetry). */
export function dispatchCaptureDecision(detail: CaptureDecisionDetail): void {
  try {
    window.dispatchEvent(new CustomEvent(CAPTURE_DECISION_EVENT, { detail }));
  } catch {
    /* ignore */
  }
}
