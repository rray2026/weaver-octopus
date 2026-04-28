import { hashString } from './hash.js';
import { messagesToMarkdown, sanitizeFilename, todayDateString } from './markdown.js';
import type { ProviderScraper } from './providers/types.js';

const DEBOUNCE_MS = 600;

export function startOrchestrator(scraper: ProviderScraper): void {
  // Record how many messages exist on page load — these are historical (not today's).
  let initialMessageCount = -1;
  let lastHash = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleCapture(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    // If generation is actively streaming, keep resetting the timer.
    if (scraper.isStreaming()) {
      debounceTimer = setTimeout(scheduleCapture, DEBOUNCE_MS);
      return;
    }
    debounceTimer = setTimeout(capture, DEBOUNCE_MS);
  }

  async function capture(): Promise<void> {
    const allMessages = scraper.scrapeMessages();

    // Set the baseline on the very first capture (page-load state = historical messages).
    if (initialMessageCount === -1) {
      initialMessageCount = allMessages.length;
      // Nothing new on this page yet — nothing to download.
      return;
    }

    const todayMessages = allMessages.slice(initialMessageCount);
    if (todayMessages.length === 0) return;

    const title = scraper.getTitle();
    const markdown = messagesToMarkdown(todayMessages, title, location.href);

    const newHash = await hashString(markdown);
    if (newHash === lastHash) return;
    lastHash = newHash;

    const filename = `weaver-octopus/${todayDateString()}/${sanitizeFilename(title)}.md`;

    chrome.runtime.sendMessage({ type: 'DOWNLOAD_REQUEST', filename, content: markdown });
  }

  // Observe the full document for any DOM changes.
  const observer = new MutationObserver(scheduleCapture);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.addEventListener('beforeunload', () => observer.disconnect());

  // Run an initial baseline capture after the DOM has fully settled.
  setTimeout(capture, 0);
}
