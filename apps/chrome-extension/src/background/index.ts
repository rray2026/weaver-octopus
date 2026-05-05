import type { ContentToBackgroundMessage, LastDownload } from '../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const TAG = '[weaver:bg]';
const MYACTIVITY_GEMINI_URL = 'https://myactivity.google.com/product/gemini';
const MYACTIVITY_QUERY_PATTERN = 'https://myactivity.google.com/product/gemini*';
// myactivity is heavyweight to load. Throttle reload requests so a hot
// stream of Gemini DOM mutations doesn't thrash the activity tab.
const MYACTIVITY_REFRESH_THROTTLE_MS = 30_000;

let seq = 0;
let lastActivityRefreshAt = 0;

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, 'onInstalled', { reason: details.reason });
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  const id = ++seq;
  const tag = `${TAG}#${id}`;
  console.log(tag, 'recv', {
    type: message?.type,
    senderUrl: sender.tab?.url,
    senderTabId: sender.tab?.id,
  });

  if (!isAllowedSender(sender.tab?.url)) {
    console.warn(tag, 'reject: sender not in host_permissions', { url: sender.tab?.url });
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

  if (message.type === 'DOWNLOAD_REQUEST') {
    console.log(tag, 'DOWNLOAD_REQUEST', {
      filename: message.filename,
      bytes: message.content?.length,
    });
    triggerDownload(message.filename, message.content, tag)
      .then((downloadId) => {
        console.log(tag, 'ack ok', { downloadId });
        sendResponse({ ok: true, downloadId });
      })
      .catch((err) => {
        console.error(tag, 'triggerDownload failed', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === 'REFRESH_ACTIVITY') {
    refreshActivityTab(tag)
      .then((res) => {
        console.log(tag, 'REFRESH_ACTIVITY ack', res);
        sendResponse(res);
      })
      .catch((err) => {
        console.error(tag, 'refreshActivityTab failed', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  console.warn(tag, 'unknown message type', message);
  sendResponse({ ok: false, error: 'unknown message type' });
  return false;
});

// Watch the lifecycle of every download we initiate so we can see whether the
// browser actually wrote the file or interrupted it (permissions, disk full,
// path invalid, conflict, etc.).
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    console.log(TAG, 'downloads.onChanged', {
      id: delta.id,
      state: delta.state.current,
      error: delta.error?.current,
    });
  }
  if (delta.error) {
    console.warn(TAG, 'download error', { id: delta.id, error: delta.error.current });
  }
});

// Trust any origin the manifest grants us host_permissions for. In production
// that's claude.ai, gemini.google.com, and myactivity.google.com (the latter
// only matters if we ever accept messages from that script — currently we don't).
function isAllowedSender(url: string | undefined): boolean {
  if (!url) return false;
  const patterns = chrome.runtime.getManifest().host_permissions ?? [];
  return patterns.some((p: string) => matchesHostPattern(url, p));
}

export function matchesHostPattern(url: string, pattern: string): boolean {
  // Minimal subset of MV3 match patterns: scheme://host/path. We only need
  // exact-host or wildcard-port matching for our tests.
  try {
    const m = pattern.match(/^([^:]+):\/\/([^/]+)(\/.*)?$/);
    if (!m) return false;
    const [, scheme, host] = m;
    const u = new URL(url);
    if (scheme !== '*' && u.protocol !== `${scheme}:`) return false;
    if (host === '*') return true;
    // host may contain ":*" to mean any port
    const [hostName, hostPort] = host!.split(':');
    if (hostName !== '*' && u.hostname !== hostName) return false;
    if (hostPort && hostPort !== '*' && u.port !== hostPort) return false;
    return true;
  } catch {
    return false;
  }
}

async function triggerDownload(filename: string, content: string, tag: string): Promise<number> {
  // Use a data: URL rather than a blob URL — blob URLs created in MV3 service
  // workers can fail silently in chrome.downloads.download on some Chrome
  // versions. Data URLs are universally supported.
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
  console.log(tag, 'chrome.downloads.download() invoke', {
    filename,
    urlBytes: url.length,
  });
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  console.log(tag, 'chrome.downloads.download() returned', { downloadId, filename });
  const last: LastDownload = { filename, at: Date.now() };
  await chrome.storage.local.set({ [LAST_DOWNLOAD_KEY]: last });
  console.log(tag, 'lastDownload persisted to storage.local');
  return downloadId;
}

interface RefreshActivityResult {
  ok: boolean;
  action?: 'created' | 'reloaded';
  reason?: string;
  tabId?: number;
}

async function refreshActivityTab(tag: string): Promise<RefreshActivityResult> {
  const now = Date.now();
  if (now - lastActivityRefreshAt < MYACTIVITY_REFRESH_THROTTLE_MS) {
    console.log(tag, 'refresh throttled', {
      sinceLast: now - lastActivityRefreshAt,
    });
    return { ok: false, reason: 'throttled' };
  }
  lastActivityRefreshAt = now;

  const tabs = await chrome.tabs.query({ url: MYACTIVITY_QUERY_PATTERN });
  if (tabs.length === 0) {
    // Open in the background — don't steal the user's focus from Gemini.
    const created = await chrome.tabs.create({ url: MYACTIVITY_GEMINI_URL, active: false });
    console.log(tag, 'created myactivity tab', { tabId: created.id });
    return { ok: true, action: 'created', tabId: created.id };
  }
  const target = tabs[0]!;
  if (target.id != null) await chrome.tabs.reload(target.id);
  console.log(tag, 'reloaded myactivity tab', { tabId: target.id });
  return { ok: true, action: 'reloaded', tabId: target.id };
}

/** Test-only: lets the test reset the in-memory throttle clock between cases. */
export function __resetActivityThrottleForTests(): void {
  lastActivityRefreshAt = 0;
}
