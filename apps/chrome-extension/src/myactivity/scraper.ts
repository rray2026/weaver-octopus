// Pure helpers for parsing date sections out of
// myactivity.google.com/product/gemini.
//
// myactivity renders prompts grouped under date headers ("今天" / "昨天" /
// "6月25日" / "Today" / "Yesterday" / "1/15/2024" / etc). Each section
// contains zero or more `<c-wiz>` item cards whose first text line carries
// a "提示 …" or "Prompt …" prefix followed by the user's prompt text.
//
// Kept pure so the content script can wire them up to a MutationObserver
// and storage.local without dragging that surface into unit tests.

import type { GeminiActivityDay, GeminiActivityIndex } from '../types/index.js';

const DATE_HEADER_PATTERNS: RegExp[] = [
  /^(今天|昨天|今日|Today|Yesterday)$/,
  /^\d{1,2}月\d{1,2}日$/,
  /^\d{4}年\d{1,2}月\d{1,2}日$/,
  /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/,
];

const TODAY_LABELS = ['今天', '今日', 'Today'];
const YESTERDAY_LABELS = ['昨天', 'Yesterday'];

const PROMPT_LINE_PREFIXES: Array<{ prefix: string; sliceLength: number }> = [
  { prefix: '提示 ', sliceLength: 3 },
  { prefix: '提示：', sliceLength: 3 },
  { prefix: 'Prompt ', sliceLength: 7 },
  { prefix: 'Prompt: ', sliceLength: 8 },
];

export function isDateHeader(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return DATE_HEADER_PATTERNS.some((re) => re.test(t));
}

/** Maps a header label like "今天" / "昨天" / "6月25日" / "Today" /
 *  "12/25/2024" / "1/15" to a YYYY-MM-DD local-date string. Returns null
 *  when the label isn't a recognised date header.
 *
 *  Year wrap: when the label has no year (e.g. "12月25日" or "1/15"), we
 *  pick the most recent date <= `now` matching that month/day. So
 *  "12月25日" seen on 2026-01-05 resolves to 2025-12-25, not 2026-12-25.
 */
export function parseDateHeader(label: string | null | undefined, now: Date): string | null {
  if (!label) return null;
  const t = label.trim();
  if (!t) return null;

  if (TODAY_LABELS.includes(t)) return ymd(now);
  if (YESTERDAY_LABELS.includes(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return ymd(d);
  }

  // Chinese with year: "2024年12月25日"
  const m1 = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (m1) return ymd(new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3])));

  // Chinese without year: "12月25日"
  const m2 = t.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m2) return resolveYearWrap(Number(m2[1]), Number(m2[2]), now);

  // Numeric M/D/YYYY (or M/D/YY)
  const m3 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m3) {
    const yearRaw = Number(m3[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    return ymd(new Date(year, Number(m3[1]) - 1, Number(m3[2])));
  }

  // Numeric M/D (no year)
  const m4 = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m4) return resolveYearWrap(Number(m4[1]), Number(m4[2]), now);

  return null;
}

/** Locates the DOM element whose first visible line is "今天" / "Today" and
 *  whose next non-trivial sibling is a `<c-wiz>` (myactivity item card).
 *  Returns null when the page has no Today section yet. Kept for
 *  back-compat with callers that only want today; new code should use
 *  `collectActivityByDate`. */
export function findTodayHeader(root: Document | Element = document): Element | null {
  const candidates = root.querySelectorAll('div');
  for (const el of candidates) {
    const firstLine = firstVisibleLine(el);
    if (!TODAY_LABELS.includes(firstLine)) continue;
    let next: Element | null = el.nextElementSibling;
    while (next && next.tagName.toLowerCase() !== 'c-wiz') {
      const sibFirst = firstVisibleLine(next);
      if (isDateHeader(sibFirst)) return null;
      next = next.nextElementSibling;
    }
    if (next && next.tagName.toLowerCase() === 'c-wiz') return el;
  }
  return null;
}

/** Extracts the prompt text from a single myactivity item card. Returns
 *  null if no recognizable prompt line is present. */
export function extractPromptFromItem(el: Element): string | null {
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    for (const { prefix, sliceLength } of PROMPT_LINE_PREFIXES) {
      if (line.startsWith(prefix)) return line.slice(sliceLength).trim();
    }
  }
  return null;
}

/** Walks the siblings after the Today header, collecting prompt strings.
 *  Kept for back-compat — equivalent to `collectActivityByDate(...).days[0]`
 *  when the topmost section is "今天" / "Today". */
export function collectTodayPrompts(root: Document | Element = document): string[] {
  const header = findTodayHeader(root);
  if (!header) return [];
  const prompts: string[] = [];
  let sib: Element | null = header.nextElementSibling;
  while (sib) {
    const firstLine = firstVisibleLine(sib);
    if (isDateHeader(firstLine)) break;
    if (sib.tagName.toLowerCase() === 'c-wiz') {
      const p = extractPromptFromItem(sib);
      if (p) prompts.push(p);
    }
    sib = sib.nextElementSibling;
  }
  return prompts;
}

/** Walks the entire myactivity document, splitting it into per-day
 *  buckets keyed by YYYY-MM-DD. Date headers are matched in DOM order;
 *  each `<c-wiz>` between two consecutive headers is attributed to the
 *  earlier header's date. Headers we can't parse a date from are skipped
 *  but still terminate the previous section.
 *
 *  Days are returned in DOM order — myactivity renders newest-first, so
 *  the first entry is typically Today. */
export function collectActivityByDate(
  root: Document | Element = document,
  now: Date = new Date(),
): GeminiActivityIndex {
  const headers = findAllDateHeaders(root);
  const days: GeminiActivityDay[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i]!;
    const next = headers[i + 1] ?? null;
    const dateStr = parseDateHeader(cur.label, now);
    if (!dateStr) continue;
    const prompts: string[] = [];
    let sib: Element | null = cur.el.nextElementSibling;
    while (sib && sib !== next?.el) {
      if (sib.tagName.toLowerCase() === 'c-wiz') {
        const p = extractPromptFromItem(sib);
        if (p) prompts.push(p);
      }
      sib = sib.nextElementSibling;
    }
    if (prompts.length > 0) days.push({ date: dateStr, prompts });
  }
  return { scrapedAt: now.toISOString(), days };
}

/** Internal: every DOM element whose first visible line is a recognised
 *  date header AND whose next non-trivial sibling is a `<c-wiz>` item card.
 *
 *  The "next sibling is c-wiz" requirement is what disambiguates the
 *  many candidates Gemini's myactivity DOM emits: each header is wrapped
 *  in 3-5 nested divs and `innerText` of every wrapper starts with the
 *  header label (because inner text cascades up). Only the LEAF header
 *  has c-wiz items as DOM siblings; every wrapper above it has the
 *  whole-day group as a single descendant. Picking siblings-of-c-wiz
 *  naturally selects exactly one element per date section. */
function findAllDateHeaders(root: Document | Element): Array<{ el: Element; label: string }> {
  const out: Array<{ el: Element; label: string }> = [];
  for (const el of root.querySelectorAll('div')) {
    const firstLine = firstVisibleLine(el);
    if (!isDateHeader(firstLine)) continue;
    // Walk forward through siblings; reject if we hit ANOTHER recognised
    // date header before we hit a c-wiz (decorative wrapper case), and
    // accept only when a c-wiz appears next.
    let next: Element | null = el.nextElementSibling;
    let hitCwiz = false;
    while (next) {
      if (next.tagName.toLowerCase() === 'c-wiz') {
        hitCwiz = true;
        break;
      }
      const sibFirst = firstVisibleLine(next);
      if (isDateHeader(sibFirst)) break;
      next = next.nextElementSibling;
    }
    if (hitCwiz) out.push({ el, label: firstLine });
  }
  return out;
}

function resolveYearWrap(month: number, day: number, now: Date): string {
  const candidate = new Date(now.getFullYear(), month - 1, day);
  if (candidate.getTime() <= startOfDay(now).getTime()) return ymd(candidate);
  // Header refers to a date later in the year than today → it must be
  // last year (myactivity is newest-first descending).
  return ymd(new Date(now.getFullYear() - 1, month - 1, day));
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function ymd(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function firstVisibleLine(el: Element): string {
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.split('\n')[0]!.trim();
}
