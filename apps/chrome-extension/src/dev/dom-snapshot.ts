// Dev-only DOM snapshot helper.
//
// Dumps a structured snapshot of the active chat tab's DOM:
// - basic page identity (url / title / hostname)
// - which selector candidates hit, and the outerHTML of the first hit
//   (so we can inspect actual structure when DOM changes break us)
// - scrapeTurns() output — text only, for sanity-checking
// - sidebar links the backfill adapter would enumerate
//
// Used by the `snapshot-dom` dev-trigger action — the content script
// builds the result, posts it back via __DEV_LOG__ so it lands in
// .dev-runtime.log alongside everything else.
//
// In production __WEAVER_DEV__ is false; everything below is dead-code-
// eliminated.

import type { DomSnapshotResult } from '../types/index.js';

// Raw selector candidates we want to probe (mirror what the providers'
// scrapers try). Kept as a flat list so the snapshot reports each one's
// hit count independently.
const TURN_CONTAINER_SELECTORS = [
  // Gemini
  '.conversation-container',
  '[data-test-id*="conversation-turn"]',
  'div[class*="conversation-container"]',
  // Claude — Claude doesn't render its full conversation in DOM (uses
  // virtualised React lists), but include a few candidates anyway so the
  // snapshot is provider-agnostic.
  'div[data-test-render-count]',
  'div[class*="font-claude-message"]',
];

const USER_QUERY_SELECTORS = [
  'user-query',
  '.user-query-bubble-with-background',
  '[class*="user-query-container"]',
];

const MODEL_RESPONSE_SELECTORS = [
  'model-response',
  'message-content',
  '[class*="model-response-text"]',
  '.markdown',
];

const SIDEBAR_LINK_SELECTORS = [
  'a[href^="/chat/"]', // Claude
  'a[href^="/app/"]', // Gemini
  'a[href*="/u/0/app/"]', // Gemini personalised URL
];

const HTML_TRUNC_LEN = 800;

export function captureDomSnapshot(
  scrapeTurns: () => Array<{ userText: string; modelText: string }>,
  enumerateSidebar: () => Array<{ href: string; title?: string }>,
): DomSnapshotResult {
  const url = location.href;
  const hostname = location.hostname;
  const title = document.title;

  const allSelectors = [
    ...TURN_CONTAINER_SELECTORS,
    ...USER_QUERY_SELECTORS,
    ...MODEL_RESPONSE_SELECTORS,
    ...SIDEBAR_LINK_SELECTORS,
  ];
  const selectorProbes: DomSnapshotResult['selectorProbes'] = [];
  for (const sel of allSelectors) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(sel);
    } catch {
      selectorProbes.push({ selector: sel, count: 0 });
      continue;
    }
    const first = matches[0];
    selectorProbes.push({
      selector: sel,
      count: matches.length,
      firstOuterHtmlTruncated: first ? truncate(first.outerHTML, HTML_TRUNC_LEN) : undefined,
    });
  }

  let turns: Array<{ userText: string; modelText: string }> = [];
  try {
    turns = scrapeTurns();
  } catch (err) {
    console.warn('[weaver:snapshot] scrapeTurns threw', err);
  }

  let sidebar: Array<{ href: string; title?: string }> = [];
  try {
    sidebar = enumerateSidebar();
  } catch (err) {
    console.warn('[weaver:snapshot] enumerateSidebar threw', err);
  }

  return {
    url,
    hostname,
    title,
    turnsCount: turns.length,
    turns,
    selectorProbes,
    sidebar,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}
