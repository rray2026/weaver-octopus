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
        userText: u ? stripUserWrapper(extractText(u)) : '',
        modelText: m ? stripModelWrapper(extractText(m)) : '',
      });
    }
    return dropGhostTurns(out);
  }

  return dropGhostTurns(
    containers.map((turn) => {
      const userEl = turn.querySelector(USER_SELECTOR_INSIDE_TURN);
      const modelEl = turn.querySelector(MODEL_SELECTOR_INSIDE_TURN);
      return {
        userText: userEl ? stripUserWrapper(extractText(userEl)) : '',
        modelText: modelEl ? stripModelWrapper(extractText(modelEl)) : '',
      };
    }),
  );
}

/** Filters out rendering-artifact turns where the user-text is empty after
 *  wrapper stripping. The Gemini DOM occasionally emits a trailing
 *  user-query element that contains ONLY the accessibility wrapper text
 *  ("你说" / "You said") with no actual prompt content — typically while
 *  the page is still hydrating, or during streaming-response transitions.
 *  Before wrapper-stripping landed, these survived as `userText: "你说"`
 *  (non-empty), so the slice walker's `if (!userText) break;` guard never
 *  fired. After stripping they collapse to `""`, which would terminate
 *  the walk PREMATURELY and miss the real today prompts further back.
 *  Drop them at the source so the walker's invariant ("every turn carries
 *  a real prompt") holds. */
function dropGhostTurns(turns: GeminiTurn[]): GeminiTurn[] {
  return turns.filter((t) => t.userText.length > 0);
}

function extractText(el: Element): string {
  const innerText = (el as HTMLElement).innerText;
  return (innerText || el.textContent || '').trim();
}

// User side: Gemini wraps each prompt in an accessibility shell that
// renders "You said" / "你说" before the actual content. innerText picks
// that up. Strip both English and Chinese variants.
const USER_WRAPPER_PREFIX_RE =
  /^(?:你[说說]|您[说說]|you\s*said|user\s*(?:said|wrote|asked|message))\s*[:：]?\s*/i;

// Model side: similar — the rendered DOM contains:
//   "显示思路"  (the "Show thinking" toggle, when collapsed)
//   "Gemini 说" / "Gemini said"  (TTS / a11y label before the answer)
// We strip both regardless of order, repeating until no more match (the
// two prefixes can appear together separated only by whitespace).
const MODEL_WRAPPER_LINE_RE =
  /^\s*(?:显示思路|show\s*thinking|gemini\s*(?:said|说|說))\s*[:：]?\s*\n?/i;

/** Strips the user-query accessibility prefix ("你说" / "You said") from
 *  rendered text. Exported for testing. */
export function stripUserWrapper(text: string): string {
  return (text || '').replace(USER_WRAPPER_PREFIX_RE, '').trim();
}

/** Strips Gemini's model-side UI artifacts ("显示思路", "Gemini 说") from
 *  rendered text. Repeats until no prefix matches. Exported for testing. */
export function stripModelWrapper(text: string): string {
  let out = text || '';
  // Cap iterations as a guard against unexpected DOM patterns.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(MODEL_WRAPPER_LINE_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
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

/** Returns the longest contiguous tail of `turns` whose user prompts each
 *  match a today myactivity entry, walking newest-first. The same
 *  myactivity entry is never reused across two turns within one call.
 *
 *  Why the "tail" constraint and not a free front-to-back scan:
 *  - myactivity is a global timeline of today's prompts but doesn't tell
 *    us *which* chat each prompt belongs to. If the user asks the same
 *    or similar prompt in N historical chats, a free scan would match
 *    each chat — across chats myactivity entries can be re-attributed,
 *    causing massive false positives during backfill.
 *  - Real-world today-turn placement is overwhelmingly at the tail: a
 *    user opening or returning to a chat to ask a question puts the new
 *    turn at the end. The "today turn in the middle of a multi-day
 *    chat" case is rare; we accept missing it as a trade-off for not
 *    flooding downloads with historical content.
 *
 *  Trade-off summary:
 *  - false negative (rare): a chat with today's question buried in the
 *    middle of older turns is skipped — the user can open it manually
 *    and the live orchestrator will then capture it as the user's next
 *    turn appends to the tail.
 *  - false positive (would be common with claim-once, now eliminated):
 *    historical chat re-downloaded because some old turn happens to
 *    contain text similar to today's prompt. */
export function computeTodaySlice(
  turns: GeminiTurn[],
  todayPrompts: string[],
): GeminiTurn[] {
  if (!Array.isArray(todayPrompts) || todayPrompts.length === 0) return [];
  let cutFrom = turns.length;
  const claimed = new Set<number>();
  for (let i = turns.length - 1; i >= 0; i--) {
    const userText = turns[i]!.userText;
    if (!userText) break;
    let matched = -1;
    // Try every unclaimed myactivity entry — order in myactivity doesn't
    // matter (the original "newest-first index" constraint relied on
    // myactivity ordering matching chat ordering, which doesn't always
    // hold).
    for (let j = 0; j < todayPrompts.length; j++) {
      if (claimed.has(j)) continue;
      if (matchesPrompt(userText, todayPrompts[j] ?? '')) {
        matched = j;
        break;
      }
    }
    if (matched < 0) break;
    claimed.add(matched);
    cutFrom = i;
  }
  return turns.slice(cutFrom);
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
  log('[gemini:slice-trace] walking newest→oldest from tail:');
  const claimed = new Set<number>();
  let stopped = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (stopped) break;
    const userText = turns[i]!.userText;
    if (!userText) {
      log(`  turn[${i}] EMPTY userText → stop`);
      break;
    }
    const u = normalizeForMatch(userText);
    if (!u) {
      log(`  turn[${i}] norm is empty → stop`);
      break;
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
      log(`  turn[${i}] NO MATCH → stop walking; this turn (and everything older) is excluded from the slice`);
      stopped = true;
      continue;
    }
    claimed.add(matched);
    log(`  turn[${i}] ✓ matched myactivity[${matched}]`);
  }
  log(`[gemini:slice-trace] done. matched ${claimed.size} of ${todayPrompts.length} myactivity entries (slice = trailing ${claimed.size} turns)`);
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

/** Stability fingerprint over ALL scraped turns. The orchestrator compares
 *  this between successive scrapes to confirm the DOM has truly settled
 *  before trusting the slice. Counting alone is too weak: during SPA
 *  navigation Gemini can leave a stale turn from the previously-viewed chat
 *  in the DOM, and if the new chat happens to land on the same turn count
 *  the count-only check passes while content is still mixed. The
 *  per-turn prefix below changes whenever any turn's user/model body
 *  shifts, so a stale-then-replaced turn forces another defer. */
export function turnsFingerprint(turns: GeminiTurn[]): string {
  return turns
    .map(
      (t) =>
        `${t.userText.length}/${t.userText.slice(0, 60)}|` +
        `${t.modelText.length}/${t.modelText.slice(0, 60)}`,
    )
    .join('§');
}
