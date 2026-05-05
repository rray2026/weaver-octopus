// Pure helpers for parsing the "今天 / Today" section out of
// myactivity.google.com/product/gemini. Kept pure so the content script
// can wire them up to a MutationObserver and storage.local without
// dragging that surface into unit tests.

const DATE_HEADER_PATTERNS: RegExp[] = [
  /^(今天|昨天|今日|Today|Yesterday)$/,
  /^\d{1,2}月\d{1,2}日$/,
  /^\d{4}年\d{1,2}月\d{1,2}日$/,
  /^\d{1,2}\/\d{1,2}/,
];

const TODAY_LABELS = ['今天', 'Today'];

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

/** Locates the DOM element whose first visible line is "今天" / "Today" and
 *  whose next non-trivial sibling is a `<c-wiz>` (myactivity item card).
 *  Returns null when the page has no Today section yet (still loading, or
 *  nothing has been recorded today). */
export function findTodayHeader(root: Document | Element = document): Element | null {
  const candidates = root.querySelectorAll('div');
  for (const el of candidates) {
    const firstLine = firstVisibleLine(el);
    if (!TODAY_LABELS.includes(firstLine)) continue;
    let next: Element | null = el.nextElementSibling;
    while (next && next.tagName.toLowerCase() !== 'c-wiz') {
      const sibFirst = firstVisibleLine(next);
      // If the next sibling is itself another date header before we found a
      // c-wiz, this "today" candidate is decorative (no items under it).
      if (isDateHeader(sibFirst)) return null;
      next = next.nextElementSibling;
    }
    if (next && next.tagName.toLowerCase() === 'c-wiz') return el;
  }
  return null;
}

/** Extracts the prompt text from a single myactivity item card. Returns null
 *  if no recognizable prompt line is present. */
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

/** Walks the siblings after the Today header, collecting prompt strings out
 *  of each `<c-wiz>` item until the next date header. */
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

function firstVisibleLine(el: Element): string {
  const text = (el as HTMLElement).innerText || el.textContent || '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.split('\n')[0]!.trim();
}
