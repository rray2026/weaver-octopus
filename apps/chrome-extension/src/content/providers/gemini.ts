// Pure DOM-scraping helpers for the Gemini provider.
//
// Unlike Claude, Gemini does not expose a single GET that returns the whole
// conversation as JSON, so we cannot use fetch-interception. Instead we read
// the rendered DOM. The Gemini DOM also has no per-turn timestamps, so to
// answer "which turns happened today" we cross-reference the prompt list
// scraped from myactivity.google.com/product/gemini (see myactivity.ts).
//
// All functions in this module are pure — they take an Element / Document /
// arrays and return data. Side-effectful pieces (MutationObserver, message
// passing, downloads) live in the orchestrator.

export interface GeminiTurn {
  userText: string;
  modelText: string;
}

const TURN_CONTAINER_SELECTORS = [
  '.conversation-container',
  '[data-test-id*="conversation-turn"]',
  'div[class*="conversation-container"]',
];

const USER_SELECTOR_INSIDE_TURN =
  'user-query, .user-query-bubble-with-background, [class*="user-query-container"]';
const MODEL_SELECTOR_INSIDE_TURN =
  'model-response, message-content, [class*="model-response-text"], .markdown';

const FALLBACK_USER_SELECTOR = 'user-query, [class*="user-query-container"]';
const FALLBACK_MODEL_SELECTOR =
  'model-response, [class*="model-response-text"], message-content';

/** Reads the conversation turns out of the Gemini DOM.
 *  Tries the structured per-turn containers first, then falls back to two
 *  parallel selector lists (pairing nth user with nth model) for layouts
 *  Gemini sometimes ships during A/B tests. */
export function scrapeTurns(root: Document | Element = document): GeminiTurn[] {
  let containers: Element[] = [];
  for (const sel of TURN_CONTAINER_SELECTORS) {
    const found = root.querySelectorAll(sel);
    if (found.length > 0) {
      containers = Array.from(found);
      break;
    }
  }

  if (containers.length === 0) {
    const userEls = Array.from(root.querySelectorAll(FALLBACK_USER_SELECTOR));
    const modelEls = Array.from(root.querySelectorAll(FALLBACK_MODEL_SELECTOR));
    const len = Math.max(userEls.length, modelEls.length);
    const out: GeminiTurn[] = [];
    for (let i = 0; i < len; i++) {
      const u = userEls[i];
      const m = modelEls[i];
      out.push({
        userText: u ? extractText(u) : '',
        modelText: m ? extractText(m) : '',
      });
    }
    return out;
  }

  return containers.map((turn) => {
    const userEl = turn.querySelector(USER_SELECTOR_INSIDE_TURN);
    const modelEl = turn.querySelector(MODEL_SELECTOR_INSIDE_TURN);
    return {
      userText: userEl ? extractText(userEl) : '',
      modelText: modelEl ? extractText(modelEl) : '',
    };
  });
}

function extractText(el: Element): string {
  const innerText = (el as HTMLElement).innerText;
  return (innerText || el.textContent || '').trim();
}

/** True when the most recent turn either has no model reply yet or the model
 *  is still streaming. We use this to delay export until the answer settles. */
export function isLastTurnIncomplete(
  turns: GeminiTurn[],
  root: Document | Element = document,
): boolean {
  if (turns.length === 0) return false;
  const last = turns[turns.length - 1]!;
  if (!last.userText) return false;
  if (!last.modelText || last.modelText.length < 5) return true;
  const busy = root.querySelector(
    '[aria-busy="true"], button[aria-label*="Stop" i], button[aria-label*="停止" i]',
  );
  return !!busy;
}

/** Returns the conversation id from a Gemini URL, or null on the welcome
 *  page. Matches /app/<id> and /u/<n>/app/<id>. */
export function getConversationIdFromUrl(href: string): string | null {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/app\/([^/?#]+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Strips the trailing "- Gemini ..." suffix Google appends to the page title. */
export function cleanTitle(rawTitle: string): string {
  if (!rawTitle) return '';
  return rawTitle.replace(/\s*[-–—]\s*Gemini.*$/i, '').trim();
}

/** Returns the subset of turns whose user prompt matches some today
 *  myactivity entry. Each myactivity entry is claimed at most once (a
 *  user prompt repeated within the chat must correspond to two distinct
 *  myactivity entries to be matched twice). Output preserves DOM order.
 *
 *  Replaces the previous "greedy from tail" semantics, which assumed
 *  today's turns were always a contiguous suffix of the conversation:
 *
 *  - The old behaviour broke for chats spanning multiple days where the
 *    user kept asking new (non-today) questions in the same conversation
 *    after asking a today question — today's match in the middle was
 *    invisible to the walker, so the chat got skipped entirely.
 *  - It also produced non-deterministic backfill outcomes: a chat that
 *    happened to render the today turn last during a partial DOM tick
 *    would download successfully, then later (with the full DOM) get
 *    skipped because a non-today turn now sat at the tail.
 *
 *  The new algorithm scans front-to-back and never decides based on tail
 *  position alone. */
export function computeTodaySlice(
  turns: GeminiTurn[],
  todayPrompts: string[],
): GeminiTurn[] {
  if (!Array.isArray(todayPrompts) || todayPrompts.length === 0) return [];
  const claimed = new Set<number>();
  const out: GeminiTurn[] = [];
  for (const turn of turns) {
    const u = turn.userText;
    if (!u) continue;
    let matched = -1;
    for (let j = 0; j < todayPrompts.length; j++) {
      if (claimed.has(j)) continue;
      if (matchesPrompt(u, todayPrompts[j] ?? '')) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      claimed.add(matched);
      out.push(turn);
    }
  }
  return out;
}

/** Returns true iff `userText` (as rendered in the chat DOM) and
 *  `activityPrompt` (as scraped from myactivity) refer to the same prompt.
 *  Centralised so the trace function and the slicer agree on the rule. */
export function matchesPrompt(userText: string, activityPrompt: string): boolean {
  const u = normalizeForMatch(userText);
  const t = normalizeForMatch(activityPrompt);
  if (!u || !t) return false;
  if (u === t) return true;
  // myactivity sometimes truncates very long prompts with "…" / "...";
  // accept a chat prompt that starts with the truncated form, provided
  // the matching prefix is substantial (≥ 8 normalised chars) — short
  // prefixes ("hi…") would otherwise false-match generic chat openings.
  if (isTruncated(activityPrompt) && t.length >= 8 && u.startsWith(t)) return true;
  return false;
}

/** True if myactivity visibly truncated this prompt (it ends with one or
 *  more '…' / '...' before whitespace). We honour prefix matching only in
 *  this case — see `findMatchIndexAfter`. */
export function isTruncated(raw: string): boolean {
  return /(?:…|\.{3,})\s*$/.test(raw.trim());
}

// Punctuation Gemini's chat-rendered text and myactivity's listing often
// disagree on at the *very end* of a prompt. Stripping these from both
// sides before comparing avoids false negatives without weakening the
// strict-equality check meaningfully.
//   ASCII:  . ? ! , ; :
//   CJK:    。 ？ ！ ， ； ：
//   ellipsis: … (single) and runs of …
const TRAILING_PUNCT_RE = /[…….?!,;:。？！，；：]+$/u;

// Gemini's chat DOM wraps each user-query in an accessibility shell that
// renders "You said" / "你说" before the actual prompt — innerText picks
// that up and prepends it to the user-typed text. myactivity stores only
// the underlying prompt, so the two would never strict-match without this
// strip. Run it on BOTH sides for symmetry (myactivity normally doesn't
// have it; if it ever does, the comparison stays consistent).
const LEADING_TTS_PREFIX_RE =
  /^(?:你[说說]|您[说說]|you\s*said|user\s*(?:said|wrote|asked|message))\s*[:：]?\s*/i;

export function normalizeForMatch(s: string): string {
  // Step 1: drop the accessibility prefix BEFORE collapsing whitespace, so
  // "You said: hello" becomes "hello" rather than "yousaid:hello" first.
  let out = (s || '').replace(LEADING_TTS_PREFIX_RE, '');
  // Step 2: drop all whitespace.
  out = out.replace(/\s+/g, '');
  // Step 3: strip trailing punctuation iteratively (e.g. "??！" → "").
  while (TRAILING_PUNCT_RE.test(out)) out = out.replace(TRAILING_PUNCT_RE, '');
  return out.toLowerCase();
}

/** Returns the smallest index > `after` whose prompt matches `prompt`, or
 *  -1 if none.
 *
 *  Match rules (deliberately strict — earlier versions also allowed
 *  `t.startsWith(u)` and substring containment in either direction, which
 *  caused yesterday's chats to false-match today's myactivity entries
 *  whenever the user asked similar / generic questions across days):
 *
 *  - exact match (after whitespace/case/trailing-ellipsis normalisation)
 *  - chat prompt starts with myactivity prompt AND the myactivity entry
 *    is visibly truncated ("…" / "..."), where the matching prefix is
 *    substantial (≥ 8 normalised chars). This is the only case where
 *    Gemini's myactivity legitimately differs from the chat-rendered
 *    version. */
export function findMatchIndexAfter(
  prompt: string,
  todayPrompts: string[],
  after: number,
): number {
  const u = normalizeForMatch(prompt);
  if (!u) return -1;
  for (let i = after + 1; i < todayPrompts.length; i++) {
    const rawT = todayPrompts[i] ?? '';
    const t = normalizeForMatch(rawT);
    if (!t) continue;
    if (u === t) return i;
    if (isTruncated(rawT) && t.length >= 8 && u.startsWith(t)) return i;
  }
  return -1;
}

/** Diagnostic dump explaining why `computeTodaySlice` returned []. Mirrors
 *  the slicer's algorithm (front-to-back, claim-once) and logs every
 *  comparison so the user can see exactly which prompt mismatched and how
 *  it normalised. Called from the orchestrator's "nothing in today slice"
 *  branch. */
export function traceSliceMismatch(
  turns: GeminiTurn[],
  todayPrompts: string[],
  log: (...args: unknown[]) => void = console.warn,
): void {
  log('[gemini:slice-trace] today prompts (newest-first, normalised):');
  if (todayPrompts.length === 0) {
    log('  (myactivity returned no today prompts)');
  } else {
    todayPrompts.forEach((p, i) => {
      log(`  myactivity[${i}] raw=${JSON.stringify(p)} → norm=${JSON.stringify(normalizeForMatch(p))} truncated=${isTruncated(p)}`);
    });
  }
  log('[gemini:slice-trace] chat turns (oldest→newest, last 10):');
  const startAt = Math.max(0, turns.length - 10);
  for (let i = startAt; i < turns.length; i++) {
    log(`  turn[${i}] user=${JSON.stringify(turns[i]!.userText)} → norm=${JSON.stringify(normalizeForMatch(turns[i]!.userText))}`);
  }
  if (todayPrompts.length === 0) return;
  log('[gemini:slice-trace] walking front→back, claim-once:');
  const claimed = new Set<number>();
  for (let i = 0; i < turns.length; i++) {
    const userText = turns[i]!.userText;
    if (!userText) {
      log(`  turn[${i}] EMPTY userText → skip`);
      continue;
    }
    const u = normalizeForMatch(userText);
    if (!u) {
      log(`  turn[${i}] norm is empty → skip`);
      continue;
    }
    let matched = -1;
    for (let j = 0; j < todayPrompts.length; j++) {
      if (claimed.has(j)) continue;
      const raw = todayPrompts[j] ?? '';
      const t = normalizeForMatch(raw);
      const eq = u === t;
      const truncPrefix =
        isTruncated(raw) && t.length >= 8 && u.startsWith(t);
      const verdict = eq ? 'EQUAL' : truncPrefix ? 'TRUNCATED-PREFIX' : 'no';
      log(`  turn[${i}] vs myactivity[${j}] u=${JSON.stringify(u)} t=${JSON.stringify(t)} → ${verdict}`);
      if (eq || truncPrefix) {
        matched = j;
        break;
      }
    }
    if (matched < 0) {
      log(`  turn[${i}] NO MATCH against any unclaimed myactivity entry`);
      continue;
    }
    claimed.add(matched);
    log(`  turn[${i}] ✓ matched myactivity[${matched}]`);
  }
  log(`[gemini:slice-trace] done. matched ${claimed.size} of ${todayPrompts.length} myactivity entries`);
}

/** Cheap content-fingerprint for in-tab dedup (avoid re-sending the same
 *  download request twice). The orchestrator also uses SHA-256 across tabs. */
export function sliceFingerprint(slice: GeminiTurn[]): string {
  const last = slice[slice.length - 1];
  const tail = (last?.modelText || last?.userText || '').slice(-60);
  const lengths = slice
    .map((t) => `${(t.userText || '').length}/${(t.modelText || '').length}`)
    .join(',');
  return `${slice.length}:${lengths}:${tail}`;
}
