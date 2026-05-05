// Gemini sidebar enumeration + SPA navigation.
//
// Gemini's sidebar markup is more volatile than Claude's because Google
// runs A/B layouts. We try a few selector candidates and use whichever
// returns the most matches. Worst case the user can manually expand the
// "显示更多" / "Show more" pane before clicking Backfill so the items are
// in the DOM.

import type { BackfillLink, BackfillProviderAdapter } from './runner.js';

const CONVERSATION_LINK_SELECTORS = [
  // Common "real" anchors with conversation ids.
  'a[href*="/app/"][href*="/c_"]',
  'a[href*="/app/"][data-test-id*="conversation"]',
  // Last resort: any /app/<id> anchor that's not the welcome page.
  'a[href^="/app/"]',
  'a[href^="/u/0/app/"]',
];

const MAX_CHATS = 200;

export const geminiBackfillAdapter: BackfillProviderAdapter = {
  provider: 'gemini',
  logTag: 'gemini',

  async enumerate(): Promise<BackfillLink[]> {
    return collectGeminiChatLinks().slice(0, MAX_CHATS);
  },

  async navigate(link: BackfillLink): Promise<void> {
    const live = findLiveAnchor(link.href);
    if (live) {
      live.click();
      return;
    }
    history.pushState({}, '', link.href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },

  matchesProviderFilename(filename: string): boolean {
    return /\[gemini\]/.test(filename);
  },
};

export function collectGeminiChatLinks(root: Document | Element = document): BackfillLink[] {
  const seen = new Set<string>();
  const out: BackfillLink[] = [];
  // Try each selector in turn; merge results in order, dedup by normalized href.
  for (const sel of CONVERSATION_LINK_SELECTORS) {
    for (const el of root.querySelectorAll<HTMLAnchorElement>(sel)) {
      const href = normalizeAppHref(el.getAttribute('href'));
      if (!href) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ href, title: extractTitle(el) });
    }
  }
  return out;
}

export function normalizeAppHref(raw: string | null): string | null {
  if (!raw) return null;
  // Strip query/fragment and make pathname-only.
  let path = raw;
  try {
    if (raw.startsWith('http')) path = new URL(raw).pathname;
  } catch {
    return null;
  }
  const m = path.match(/\/app\/([^/?#]+)/);
  if (!m) return null;
  // The "welcome page" /app or /app/ has no id segment — already filtered by the regex.
  // Reject the literal id "new" or empty just in case.
  const id = m[1]!;
  if (!id || id === 'new') return null;
  return `/app/${id}`;
}

function extractTitle(el: Element): string {
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed) return trimmed;
  const aria = el.getAttribute('aria-label');
  return aria ? aria.trim() : '';
}

function findLiveAnchor(href: string): HTMLAnchorElement | null {
  for (const el of document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]')) {
    if (normalizeAppHref(el.getAttribute('href')) === href) return el;
  }
  return null;
}
