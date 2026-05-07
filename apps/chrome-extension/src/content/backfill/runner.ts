// Shared backfill runner.
//
// A backfill walks the provider's chat sidebar in order, navigates to each
// chat via SPA push-state, and waits for a "capture decision" from the
// orchestrator: either a download (lastDownload advanced) or a CustomEvent
// announcing why the orchestrator chose to skip (date out of range, hash
// already cached, etc.).
//
// Two-channel signalling:
//   1. Window CustomEvent  (`weaver-octopus:capture-decision`) — synchronous
//      with the orchestrator's decision, fires for both downloads AND skips.
//      This is what lets out-of-range chats short-circuit instead of
//      consuming the full per-chat timeout.
//   2. chrome.storage.local lastDownload — fallback in case the orchestrator
//      took the download path but the in-tab event was missed (paranoia
//      guard, also keeps the runner working if the event protocol changes).
//
// Pacing: minIntervalMs..maxIntervalMs jittered between chats.

import {
  CAPTURE_DECISION_EVENT,
  type CaptureDecisionDetail,
} from '../captureEvents.js';
import type {
  BackfillLogEntry,
  BackfillProviderProgressPatch,
  LastDownload,
  Provider,
} from '../../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const STOP_FLAG_KEY = 'backfillStopRequested';
const TAG_BASE = '[weaver:backfill]';

export interface BackfillLink {
  /** SPA-internal URL of the chat (e.g. /chat/<id>). Absolute or relative both work. */
  href: string;
  /** Chat title from the sidebar item. Used for the log + popup display. */
  title?: string;
}

/** Reserved for future per-iteration context (e.g. attempt number, abort
 *  signal). Currently empty — adapters just navigate by clicking the live
 *  sidebar anchor and let the live orchestrator capture the resulting fetch. */
export interface BackfillNavigateContext {
  // Intentionally empty.
}

export interface BackfillProviderAdapter {
  provider: Provider;
  /** Reads the sidebar and returns chats to visit, in display order. */
  enumerate(): Promise<BackfillLink[]>;
  /** Carries the runner to the chat so the orchestrator can capture it —
   *  typically by clicking the live sidebar anchor (or, as a fallback,
   *  pushing a SPA history entry). */
  navigate(link: BackfillLink, ctx: BackfillNavigateContext): Promise<void>;
  /** Returns true if the lastDownload filename was produced by THIS provider's
   *  orchestrator. Used to avoid cross-provider stealing of "advance" signals. */
  matchesProviderFilename(filename: string): boolean;
  /** Pulls the conversation id out of a link. Used to match incoming
   *  CAPTURE_DECISION events to the chat we're currently visiting. */
  extractConversationId(link: BackfillLink): string | null;
  /** Provider tag for logs. */
  logTag: string;
}

export interface BackfillRunOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  perChatTimeoutMs: number;
  /** How often to poll lastDownload for changes (ms). */
  pollIntervalMs?: number;
  /** Stop the rest of the batch after this many consecutive
   *  `skipped:date` outcomes — both Claude and Gemini sort their non-pinned
   *  sidebar chats newest-first, so once we cross the date-range boundary
   *  every remaining non-pinned chat will also be out of range.
   *
   *  Pinned chats appear first and are NOT date-ordered, so we use a
   *  threshold (not single-event) to absorb the case where the user has a
   *  handful of old pins before reaching the in-range region. Default: 5,
   *  which is comfortably above typical pin counts.
   *
   *  Set to 0 to disable early termination (visit every enumerated chat).
   *  Other skip reasons (cached, empty, other) reset the counter. */
  stopAfterConsecutiveDateSkips?: number;
  /** Hooks for testability + reporting. Production wiring sends these patches
   *  through `chrome.runtime.sendMessage` to the background coordinator. */
  reportPatch: (patch: BackfillProviderProgressPatch) => void | Promise<void>;
}

export async function runBackfill(
  adapter: BackfillProviderAdapter,
  opts: BackfillRunOptions,
): Promise<void> {
  const tag = `${TAG_BASE}[${adapter.logTag}]`;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const stopAfterConsecutiveDateSkips = opts.stopAfterConsecutiveDateSkips ?? 5;

  console.log(tag, 'starting enumerate');
  const links = await adapter.enumerate();
  console.log(tag, 'enumerated', { count: links.length });
  await opts.reportPatch({ total: links.length });

  // Both Claude and Gemini sort their non-pinned sidebar chats newest-first.
  // After this many consecutive `skipped:date` outcomes we assume we've
  // crossed the date-range boundary and abort the rest of the batch.
  let consecutiveDateSkips = 0;

  for (let i = 0; i < links.length; i++) {
    if (await isStopRequested()) {
      console.log(tag, 'stop flag observed, aborting at', i);
      await opts.reportPatch({
        currentTitle: null,
        appendLog: [
          {
            at: Date.now(),
            provider: adapter.provider,
            status: 'skipped',
            reason: 'stopped by user',
          },
        ],
      });
      return;
    }

    const link = links[i]!;
    const title = link.title ?? '(untitled)';
    const expectedConvId = adapter.extractConversationId(link);
    console.log(tag, `visit ${i + 1}/${links.length}`, {
      title,
      href: link.href,
      convId: expectedConvId,
    });
    await opts.reportPatch({ currentTitle: title });

    const before = await readLastDownload();
    let outcome: BackfillLogEntry;
    try {
      // Subscribe to decision events BEFORE navigating — orchestrators that
      // process the URL change synchronously could otherwise fire before we
      // attach the listener.
      const decisionPromise = expectedConvId
        ? waitForDecision(adapter.provider, expectedConvId, opts.perChatTimeoutMs)
        : null;

      await adapter.navigate(link, {});

      const result = await waitForCaptureSignal(
        adapter,
        before,
        decisionPromise,
        opts.perChatTimeoutMs,
        pollIntervalMs,
      );

      if (result.outcome === 'ok') {
        outcome = {
          at: Date.now(),
          provider: adapter.provider,
          status: 'ok',
          title,
          href: link.href,
        };
        // `done` uses the same INCREMENT semantics as `skipped`/`failed`;
        // sending `i + 1` would over-count because the loop index includes
        // earlier visits that were skipped, not downloaded. (Caused the
        // "gemini done=2 but only 1 file" demo accounting bug.)
        await opts.reportPatch({ done: 1, appendLog: [outcome] });
        consecutiveDateSkips = 0;
      } else {
        outcome = {
          at: Date.now(),
          provider: adapter.provider,
          status: 'skipped',
          title,
          href: link.href,
          reason: result.reason,
        };
        await opts.reportPatch({ skipped: 1, appendLog: [outcome] });
        if (result.action === 'skipped:date') {
          // "older than range.start" — rest of the date-sorted sidebar is too
          consecutiveDateSkips++;
        } else if (result.action === 'skipped:date:newer') {
          // "newer than range.end" — we're walking the most-recent chats
          // that haven't reached the target date yet. Don't count these
          // toward early-stop; reset to 0 so any later "too-old" streak
          // starts fresh from when we actually exit the range.
          consecutiveDateSkips = 0;
        } else {
          // Cached/empty/other shouldn't count toward the early-termination
          // threshold — only "definitely outside the user's date range" does.
          consecutiveDateSkips = 0;
        }
      }

      if (
        stopAfterConsecutiveDateSkips > 0 &&
        consecutiveDateSkips >= stopAfterConsecutiveDateSkips &&
        i + 1 < links.length
      ) {
        const remaining = links.length - (i + 1);
        const earlyStop: BackfillLogEntry = {
          at: Date.now(),
          provider: adapter.provider,
          status: 'skipped',
          reason: `early stop: ${consecutiveDateSkips} consecutive out-of-range chats — assuming the remaining ${remaining} are also out of range (sidebar is date-sorted)`,
        };
        console.log(tag, 'early termination', {
          consecutiveDateSkips,
          remaining,
        });
        await opts.reportPatch({
          currentTitle: null,
          appendLog: [earlyStop],
        });
        return;
      }
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      outcome = {
        at: Date.now(),
        provider: adapter.provider,
        status: 'failed',
        title,
        href: link.href,
        reason,
      };
      console.warn(tag, 'visit failed, logging and continuing', err);
      await opts.reportPatch({ failed: 1, appendLog: [outcome] });
      // Failure is ambiguous (we couldn't determine date range) — don't
      // count it toward early termination.
      consecutiveDateSkips = 0;
    }

    if (i < links.length - 1) {
      const delay = jitter(opts.minIntervalMs, opts.maxIntervalMs);
      console.log(tag, `pacing ${delay}ms before next`);
      // Pacing must observe the stop flag promptly — otherwise a stop
      // request mid-pacing would wait the full 4–6s before the loop's
      // top-of-iteration check fires.
      await sleepAbortable(delay, isStopRequested);
    }
  }

  await opts.reportPatch({ currentTitle: null });
  console.log(tag, 'done');
}

interface WaitResult {
  outcome: 'ok' | 'skipped';
  reason?: string;
  /** Echoes the orchestrator's terminal action when one was observed —
   *  used by the runner's early-termination logic to count consecutive
   *  date-skips precisely (other skip reasons reset the counter). */
  action?: CaptureDecisionDetail['action'];
}

/** Resolves as soon as either signal arrives:
 *   - matching CAPTURE_DECISION event (best-case ~100ms after navigate)
 *   - lastDownload advances with our provider's filename (paranoia fallback)
 * Or times out and returns "skipped" with a generic timeout reason. */
async function waitForCaptureSignal(
  adapter: BackfillProviderAdapter,
  before: LastDownload | undefined,
  decisionPromise: Promise<CaptureDecisionDetail | 'timeout'> | null,
  timeoutMs: number,
  pollMs: number,
): Promise<WaitResult> {
  const downloadPromise = waitForOurDownload(adapter, before, timeoutMs, pollMs);
  // Race the two channels — whoever resolves first wins.
  const winner = await Promise.race([
    decisionPromise
      ? decisionPromise.then((d) => ({ kind: 'decision' as const, d }))
      : new Promise<never>(() => undefined),
    downloadPromise.then((advanced) => ({ kind: 'download' as const, advanced })),
  ]);

  if (winner.kind === 'decision' && winner.d !== 'timeout') {
    if (winner.d.action === 'downloaded') {
      return { outcome: 'ok', action: 'downloaded' };
    }
    return {
      outcome: 'skipped',
      reason: winner.d.reason ?? winner.d.action,
      action: winner.d.action,
    };
  }
  if (winner.kind === 'download' && winner.advanced) {
    return { outcome: 'ok', action: 'downloaded' };
  }
  // Download channel returned false (timeout OR stop flag observed). Do NOT
  // await decisionPromise here — its internal setTimeout will fire and remove
  // the listener on its own schedule. Awaiting it would gate stop-latency on
  // the full perChatTimeoutMs (~20s of "正在停止" UI hang). The pending
  // setTimeout/listener pair becomes garbage after the timer fires; not a
  // real leak.
  return {
    outcome: 'skipped',
    reason: 'no decision/download captured within timeout (cached / empty)',
  };
}

async function waitForOurDownload(
  adapter: BackfillProviderAdapter,
  before: LastDownload | undefined,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const baseAt = before?.at ?? 0;
  const baseFn = before?.filename;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isStopRequested()) return false;
    const last = await readLastDownload();
    if (
      last &&
      adapter.matchesProviderFilename(last.filename) &&
      (last.at > baseAt || last.filename !== baseFn)
    ) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

/** Listens for an in-tab CaptureDecision event matching the (provider, convId)
 *  we expect for the chat just navigated to. Resolves with the event detail,
 *  or 'timeout' after timeoutMs. Always cleans up its listener. */
function waitForDecision(
  provider: Provider,
  conversationId: string,
  timeoutMs: number,
): Promise<CaptureDecisionDetail | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;
    const onEvent = (ev: Event): void => {
      const detail = (ev as CustomEvent<CaptureDecisionDetail>).detail;
      if (!detail) return;
      if (detail.provider !== provider) return;
      if (detail.conversationId !== conversationId) return;
      if (settled) return;
      settled = true;
      window.removeEventListener(CAPTURE_DECISION_EVENT, onEvent);
      clearTimeout(timer);
      resolve(detail);
    };
    window.addEventListener(CAPTURE_DECISION_EVENT, onEvent);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener(CAPTURE_DECISION_EVENT, onEvent);
      resolve('timeout');
    }, timeoutMs);
  });
}

/** sleep(ms) but checks the stop predicate every poll interval and resolves
 *  early if it returns true. Used for pacing between chats so a stop request
 *  doesn't wait out the full 4–6s jitter before being observed. */
async function sleepAbortable(
  totalMs: number,
  shouldStop: () => Promise<boolean>,
  pollMs = 200,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalMs) {
    if (await shouldStop()) return;
    const remaining = totalMs - (Date.now() - startedAt);
    await sleep(Math.min(pollMs, remaining));
  }
}

async function readLastDownload(): Promise<LastDownload | undefined> {
  try {
    const items = await chrome.storage.local.get(LAST_DOWNLOAD_KEY);
    return items[LAST_DOWNLOAD_KEY] as LastDownload | undefined;
  } catch {
    return undefined;
  }
}

async function isStopRequested(): Promise<boolean> {
  try {
    const items = await chrome.storage.local.get(STOP_FLAG_KEY);
    return Boolean(items[STOP_FLAG_KEY]);
  } catch {
    return false;
  }
}

export function jitter(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
