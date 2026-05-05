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

export interface BackfillProviderAdapter {
  provider: Provider;
  /** Reads the sidebar and returns chats to visit, in display order. */
  enumerate(): Promise<BackfillLink[]>;
  /** Triggers SPA navigation to the chat. Caller awaits whatever this returns. */
  navigate(link: BackfillLink): Promise<void>;
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

  console.log(tag, 'starting enumerate');
  const links = await adapter.enumerate();
  console.log(tag, 'enumerated', { count: links.length });
  await opts.reportPatch({ total: links.length });

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

      await adapter.navigate(link);

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
        await opts.reportPatch({ done: i + 1, appendLog: [outcome] });
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
    }

    if (i < links.length - 1) {
      const delay = jitter(opts.minIntervalMs, opts.maxIntervalMs);
      console.log(tag, `pacing ${delay}ms before next`);
      await sleep(delay);
    }
  }

  await opts.reportPatch({ currentTitle: null });
  console.log(tag, 'done');
}

interface WaitResult {
  outcome: 'ok' | 'skipped';
  reason?: string;
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
    if (winner.d.action === 'downloaded') return { outcome: 'ok' };
    return { outcome: 'skipped', reason: winner.d.reason ?? winner.d.action };
  }
  if (winner.kind === 'download' && winner.advanced) {
    return { outcome: 'ok' };
  }
  // Both channels timed out (or download channel returned false without
  // advance). Wait for the decision channel to also resolve so we don't
  // leak its listener — but cap at the same overall timeout.
  if (decisionPromise) await decisionPromise.catch(() => undefined);
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
