// Claude sidebar enumeration + SPA navigation.
//
// Selectors are kept at the top so they're easy to update if claude.ai
// reshuffles its sidebar markup.

import type {
  BackfillLink,
  BackfillNavigateContext,
  BackfillProviderAdapter,
} from './runner.js';

const CHAT_LINK_SELECTORS = [
  // Most stable: any anchor whose href starts with /chat/<id>.
  'a[href^="/chat/"]',
];

/** Maximum number of chats we'll enumerate per backfill run. The Claude
 *  sidebar lazy-loads — for MVP we only take what's already mounted. Users
 *  who need older chats can scroll the sidebar manually before clicking
 *  "Backfill" (the content script picks up whatever is in the DOM at that
 *  point). */
const MAX_CHATS = 200;

export const claudeBackfillAdapter: BackfillProviderAdapter = {
  provider: 'claude',
  logTag: 'claude',

  async enumerate(): Promise<BackfillLink[]> {
    const links = collectClaudeChatLinks();
    return links.slice(0, MAX_CHATS);
  },

  async navigate(link: BackfillLink, _ctx: BackfillNavigateContext): Promise<void> {
    // Find the live anchor again — calling .click() on a stale element
    // grabbed before this iteration risks the SPA having re-rendered the
    // sidebar.
    const live = findLiveAnchor(link.href);
    if (live) {
      live.click();
      return;
    }
    // Fallback: programmatic pushState. The Claude SPA listens to popstate
    // and re-fetches the conversation when the URL changes.
    history.pushState({}, '', link.href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },

  matchesProviderFilename(filename: string): boolean {
    // The Claude orchestrator names downloads "[claude] <title>-<id8>.md"
    // under weaver-octopus/<date>/. The provider tag is unambiguous.
    return /\[claude\]/.test(filename);
  },

  extractConversationId(link): string | null {
    // The runner uses this to match incoming CAPTURE_DECISION events. The
    // Claude orchestrator reports the full UUID, which is exactly what's in
    // the /chat/<uuid> path segment we already normalised.
    const m = link.href.match(/\/chat\/([0-9a-fA-F-]{36})/);
    return m ? m[1]! : null;
  },
};

export function collectClaudeChatLinks(root: Document | Element = document): BackfillLink[] {
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
  return out;
}

function normalizeChatHref(el: HTMLAnchorElement): string | null {
  const raw = el.getAttribute('href');
  if (!raw) return null;
  // Some anchors carry tracking suffixes in pathname; the chat id segment
  // is enough for SPA navigation.
  const match = raw.match(/^\/chat\/([0-9a-fA-F-]{36})/);
  if (!match) return null;
  return `/chat/${match[1]}`;
}

function extractTitle(el: Element): string {
  // The anchor often contains nested spans / icons; use textContent and
  // trim. If empty, fall back to aria-label.
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed) return trimmed;
  const aria = el.getAttribute('aria-label');
  return aria ? aria.trim() : '';
}

function findLiveAnchor(href: string): HTMLAnchorElement | null {
  // Look for any anchor whose normalized href matches.
  for (const el of document.querySelectorAll<HTMLAnchorElement>('a[href^="/chat/"]')) {
    if (normalizeChatHref(el) === href) return el;
  }
  return null;
}
