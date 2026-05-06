// Auto-reload loop + service-worker keepalive.
//
// On every successful Vite rebuild, the extDevPlugin emits a fresh
// dist/build_id.txt. The SW polls that file every 2s; on change it
// chrome.runtime.reload()s itself, then refreshes every tab matched
// by host_permissions so the new content scripts inject.
//
// chrome.alarms keepalive (30s) ensures SW boots back up even after
// deep system idle (laptop sleep / suspend), where setInterval alone
// stops firing.

const BUILD_ID_PATH = 'build_id.txt';
const TAB_REFRESH_FLAG_KEY = 'extDevRpcNeedsTabRefresh';
const POLL_MS = 2_000;
const KEEPALIVE_ALARM = 'ext-dev-rpc-keepalive';

let started = false;

export function startAutoReload(opts: { tag?: string } = {}): void {
  if (started) return;
  started = true;
  const tag = opts.tag ?? '[ext-dev-rpc:auto-reload]';
  console.log(tag, 'poller started');

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
      console.log(tag, 'build changed, reloading extension', {
        from: lastSeenId,
        to: id,
      });
      lastSeenId = id;
      try {
        await chrome.storage.local.set({ [TAB_REFRESH_FLAG_KEY]: true });
      } catch {
        /* non-fatal */
      }
      chrome.runtime.reload();
    } catch {
      /* build_id.txt may briefly disappear during emptyOutDir — silent */
    }
  }, POLL_MS);

  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) {
        console.log(tag, 'keepalive tick');
      }
    });
  } catch (err) {
    console.warn(tag, 'keepalive alarm setup failed', err);
  }
}

/** Hook to register on chrome.runtime.onInstalled. Refreshes any tabs
 *  matched by host_permissions if the previous SW set the flag. */
export async function onInstalledRefreshTabs(opts: { tag?: string } = {}): Promise<void> {
  const tag = opts.tag ?? '[ext-dev-rpc:auto-reload]';
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
  console.log(tag, 'refreshing tabs matched by', patterns);
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const t of tabs) if (t.id != null) await chrome.tabs.reload(t.id);
    } catch (err) {
      console.warn(tag, 'failed to reload tabs for pattern', pattern, err);
    }
  }
  console.log(tag, 'tab refresh done');
}
