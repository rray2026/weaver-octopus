// ChatGPT sidebar enumeration + SPA navigation.
//
// Selectors verified against the live chatgpt.com sidebar (probe ts
// 1778057812000): every chat anchor matches `a[href^="/c/"]` whose
// pathname is exactly `/c/<uuid>` and whose innerText is the chat
// title. Custom-GPT chats may show as `/g/<gizmo>/c/<uuid>` — we'll
// pick those up too via a broader `[href*="/c/"]` fallback.

import type {
  BackfillLink,
  BackfillNavigateContext,
  BackfillProviderAdapter,
} from './runner.js';

const CHAT_LINK_SELECTORS = [
  // Most stable: any anchor whose href starts with /c/<id>.
  'a[href^="/c/"]',
];
// Custom GPT chat anchors live under /g/<gizmo>/c/<id>; pick those up
// after the primary selector, with the same id-extraction regex.
const CUSTOM_GPT_LINK_SELECTOR = 'a[href*="/c/"]';

const UUID_RE = /\/c\/([0-9a-fA-F-]{36})/;

/** Maximum number of chats we'll enumerate per backfill run. The ChatGPT
 *  sidebar lazy-loads — for MVP we only take what's already mounted. */
const MAX_CHATS = 200;

export const chatgptBackfillAdapter: BackfillProviderAdapter = {
  provider: 'chatgpt',
  logTag: 'chatgpt',

  async enumerate(): Promise<BackfillLink[]> {
    return collectChatGPTChatLinks().slice(0, MAX_CHATS);
  },

  async navigate(link: BackfillLink, _ctx: BackfillNavigateContext): Promise<void> {
    // Click the live anchor when it's still in the DOM. Calling .click()
    // on a stale element risks the SPA having re-rendered the sidebar.
    const live = findLiveAnchor(link.href);
    if (live) {
      live.click();
      return;
    }
    // Fallback: programmatic SPA navigation. ChatGPT listens for
    // popstate (verified live: pushState + popstate triggers the
    // /backend-api/conversation/<id> GET our intercept catches).
    history.pushState({}, '', link.href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },

  matchesProviderFilename(filename: string): boolean {
    // The orchestrator names downloads "[chatgpt] <title>-<id8>.md".
    return /\[chatgpt\]/.test(filename);
  },

  extractConversationId(link): string | null {
    const m = link.href.match(UUID_RE);
    return m ? m[1]! : null;
  },
};

export function collectChatGPTChatLinks(
  root: Document | Element = document,
): BackfillLink[] {
  const seen = new Set<string>();
  const out: BackfillLink[] = [];
  for (const sel of CHAT_LINK_SELECTORS) {
    for (const el of root.querySelectorAll<HTMLAnchorElement>(sel)) {
      const href = normalizeChatHref(el);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ href, title: extractTitle(el) });
    }
  }
  // Custom-GPT chats — same id, different prefix path.
  for (const el of root.querySelectorAll<HTMLAnchorElement>(CUSTOM_GPT_LINK_SELECTOR)) {
    const href = normalizeChatHref(el);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title: extractTitle(el) });
  }
  return out;
}

function normalizeChatHref(el: HTMLAnchorElement): string | null {
  const raw = el.getAttribute('href');
  if (!raw) return null;
  const m = raw.match(UUID_RE);
  if (!m) return null;
  // Preserve the full path (so /g/<gizmo>/c/<uuid> goes back to that
  // gizmo's URL on click). For root chats this is the same as `/c/<uuid>`.
  return raw;
}

function extractTitle(el: Element): string {
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed) return trimmed;
  const aria = el.getAttribute('aria-label');
  return aria ? aria.trim() : '';
}

function findLiveAnchor(href: string): HTMLAnchorElement | null {
  // Match by uuid alone — sidebar may or may not include the /g/<gizmo>
  // prefix in the live anchor depending on which view is active.
  const id = href.match(UUID_RE)?.[1];
  if (!id) return null;
  for (const el of document.querySelectorAll<HTMLAnchorElement>(CUSTOM_GPT_LINK_SELECTOR)) {
    if (el.getAttribute('href')?.includes(`/c/${id}`)) return el;
  }
  return null;
}
