import type { ContentToBackgroundMessage, LastDownload } from '../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const TAG = '[weaver:bg]';

let seq = 0;

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
// that's claude.ai only; in the e2e test build it also includes localhost.
function isAllowedSender(url: string | undefined): boolean {
  if (!url) return false;
  const patterns = chrome.runtime.getManifest().host_permissions ?? [];
  return patterns.some((p: string) => matchesHostPattern(url, p));
}

function matchesHostPattern(url: string, pattern: string): boolean {
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
