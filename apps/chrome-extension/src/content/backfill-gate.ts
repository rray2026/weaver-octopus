// Per-tab in-memory flag the orchestrator's processing entry checks
// before doing any work. Set to true by `installBackfillListener` while
// the backfill runner is driving this tab; false otherwise.
//
// Effect: the MAIN-world fetch intercept stays installed at all times
// (it's load-time-only, no live toggle), but the ISOLATED-world
// orchestrator drops every observed CONVERSATION message when the flag
// is false. So passive browsing produces zero downloads — only batch
// backfill writes files.
//
// Earlier iterations of this module also offered a popup toggle that
// let the user opt INTO live capture (auto-download every visited
// chat). That feature was removed: it added a dual-path gate, a
// chrome.storage.local key (`liveCaptureEnabled`), and a popup
// checkbox — none of which earned their keep. The simpler "backfill
// is the only thing that downloads" rule matches the way every
// provider already behaved by default.

let backfillInFlight = false;

/** True if the orchestrator is allowed to process the current chat. */
export function isBackfillInFlight(): boolean {
  return backfillInFlight;
}

/** Set by the backfill listener around its run so the orchestrator's
 *  entry gate lets events through. */
export function setBackfillInFlight(value: boolean): void {
  backfillInFlight = value;
}
