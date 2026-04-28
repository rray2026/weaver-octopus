import type { ContentToBackgroundMessage } from '../types/index.js';
import type { ChatSession } from '../types/index.js';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[weaver-octopus] Extension installed.');
});

chrome.runtime.onMessage.addListener(
  (message: ContentToBackgroundMessage, _sender, sendResponse) => {
    if (message.type === 'SESSION_UPDATE' || message.type === 'SESSION_START') {
      persistSession(message.session).then(() => sendResponse({ ok: true }));
    } else if (message.type === 'DOWNLOAD_REQUEST') {
      triggerDownload(message.filename, message.content).then(() => sendResponse({ ok: true }));
    }
    return true;
  },
);

async function persistSession(session: ChatSession): Promise<void> {
  const key = `session:${session.id}`;
  await chrome.storage.local.set({ [key]: session });
}

async function triggerDownload(filename: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
