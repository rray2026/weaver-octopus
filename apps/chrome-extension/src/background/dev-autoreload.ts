// Dev-only auto-reload loop.
//
// Workflow:
//   $ WEAVER_DEV=1 pnpm --filter @weaver-octopus/chrome-extension dev
//
// Each successful Vite rebuild rewrites dist/build_id.txt with a new
// timestamp. The background service worker polls that file every few
// seconds; when it changes, the SW persists a "refresh tabs after
// reload" flag in chrome.storage.local and calls chrome.runtime.reload().
//
// After the new SW starts, chrome.runtime.onInstalled fires (reason
// 'update' for an unpacked extension reload). We notice the flag,
// refresh every tab matched by host_permissions so the new content
// scripts inject, and clear the flag.
//
// In production builds __WEAVER_DEV__ is false and the entire module is
// dead-code-eliminated by Rollup (the importer guards every entry point
// with `if (__WEAVER_DEV__)`).

const BUILD_ID_PATH = 'build_id.txt';
const TAB_REFRESH_FLAG_KEY = 'devNeedsTabRefresh';
const POLL_MS = 2_000;
const TAG = '[weaver:dev-autoreload]';

/** Starts the polling loop. Idempotent — extra calls are no-ops. */
export function startDevAutoReload(): void {
  if (started) return;
  started = true;
  console.log(TAG, 'poller started (every', POLL_MS, 'ms)');
  let lastSeenId: string | null = null;
  setInterval(async () => {
    try {
      const url = chrome.runtime.getURL(BUILD_ID_PATH);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const id = (await res.text()).trim();
      if (!id) return;
      if (lastSeenId == null) {
        lastSeenId = id;
        return;
      }
      if (id === lastSeenId) return;
      console.log(TAG, 'build changed, reloading extension', {
        from: lastSeenId,
        to: id,
      });
      lastSeenId = id;
      // Persist a flag the new SW reads on startup — chrome.runtime.reload
      // tears down this SW so anything we want to do "after the reload"
      // has to be picked up by the new instance.
      try {
        await chrome.storage.local.set({ [TAB_REFRESH_FLAG_KEY]: true });
      } catch {
        /* non-fatal — tabs may need a manual refresh */
      }
      chrome.runtime.reload();
    } catch {
      // build_id.txt may briefly disappear during a Vite emptyOutDir step.
      // Swallow — the next poll picks it back up.
    }
  }, POLL_MS);
}

let started = false;

/** Hook into chrome.runtime.onInstalled. If the previous SW set the
 *  refresh flag (i.e. we just reloaded ourselves), refresh every tab
 *  matched by host_permissions so the new content scripts inject. */
export async function devOnInstalled(
  details: chrome.runtime.InstalledDetails,
): Promise<void> {
  console.log(TAG, 'onInstalled', { reason: details.reason });
  let needsRefresh = false;
  try {
    const items = await chrome.storage.local.get(TAB_REFRESH_FLAG_KEY);
    needsRefresh = Boolean(items[TAB_REFRESH_FLAG_KEY]);
    if (needsRefresh) await chrome.storage.local.remove(TAB_REFRESH_FLAG_KEY);
  } catch {
    /* ignore */
  }
  if (!needsRefresh) return;
  const patterns = chrome.runtime.getManifest().host_permissions ?? [];
  console.log(TAG, 'refreshing tabs in', patterns);
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const t of tabs) {
        if (t.id != null) await chrome.tabs.reload(t.id);
      }
    } catch (err) {
      console.warn(TAG, 'failed to reload tabs for pattern', pattern, err);
    }
  }
  console.log(TAG, 'tab refresh done');
}
