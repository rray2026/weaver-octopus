// Gate that decides whether the live orchestrators should actually
// PROCESS a chat (parse + hash + download) when they observe one.
//
// Two reasons to allow:
//  1. The user explicitly enabled "live capture" in the popup.
//  2. A backfill is currently in flight in this tab — the orchestrator
//     IS the mechanism backfill uses to pull a chat down once it's
//     navigated to, so we always want it active during that window.
//
// Default = OFF (gate denies). Switching the popup checkbox flips the
// gate immediately for already-loaded pages via storage.onChanged.

const STORAGE_KEY = 'liveCaptureEnabled';

let cached: boolean | null = null;
let backfillInFlight = false;

/** True if the orchestrator is allowed to process the current chat.
 *  Cheap call — uses a cached storage read. */
export async function isLiveCaptureAllowed(): Promise<boolean> {
  if (backfillInFlight) return true;
  if (cached === null) {
    try {
      const items = await chrome.storage.local.get(STORAGE_KEY);
      cached = items[STORAGE_KEY] === true;
    } catch {
      cached = false;
    }
  }
  return cached;
}

/** Set by the backfill listener around its run so the gate doesn't
 *  block backfill-initiated captures even when live mode is off. */
export function setBackfillInFlight(value: boolean): void {
  backfillInFlight = value;
}

// Live updates: a popup toggle flip should take effect on already-loaded
// pages without requiring a refresh.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (change) cached = change.newValue === true;
  });
} catch {
  // chrome.storage may be unavailable in tests / non-extension contexts.
}
