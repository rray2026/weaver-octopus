import type { ChatSession, ContentToBackgroundMessage } from '../types/index.js';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[weaver-octopus] Extension installed.');
});

chrome.runtime.onMessage.addListener(
  (message: ContentToBackgroundMessage, _sender, sendResponse) => {
    if (message.type === 'SESSION_UPDATE' || message.type === 'SESSION_START') {
      persistSession(message.session);
      sendResponse({ ok: true });
    }
    return true;
  },
);

async function persistSession(session: ChatSession): Promise<void> {
  const key = `session:${session.id}`;
  await chrome.storage.local.set({ [key]: session });
}
