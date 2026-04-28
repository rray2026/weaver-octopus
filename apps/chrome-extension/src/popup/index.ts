import type { ChatSession } from '../types/index.js';

async function init(): Promise<void> {
  const statusEl = document.getElementById('status')!;

  const items = await chrome.storage.local.get(null);
  const sessions: ChatSession[] = Object.values(items).filter(
    (v): v is ChatSession => typeof v === 'object' && v !== null && 'provider' in v,
  );

  if (sessions.length === 0) {
    statusEl.textContent = 'No captured sessions yet. Open Gemini, ChatGPT, or Claude.';
    return;
  }

  statusEl.textContent = `${sessions.length} session(s) captured.`;
}

init();
