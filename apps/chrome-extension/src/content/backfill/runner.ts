// Shared backfill runner.
//
// A backfill walks the provider's chat sidebar in order, navigating to each
// chat via SPA push-state and waiting until the *passive* orchestrator has
// produced a download (lastDownload timestamp advances). Then it pauses for
// minIntervalMs..maxIntervalMs (jittered) and moves to the next.
//
// The runner is provider-agnostic. Each provider passes:
//   - enumerate(): returns the ordered list of (href, title) pairs
//   - navigate(link): pushState + click side-effects to load that chat
//   - matchesProviderFilename(name): used to verify a download was for *us*
//
// Why "wait for lastDownload to advance" rather than e.g. listening for the
// orchestrator's chrome.runtime.sendMessage ack: keeping the runner ignorant
// of orchestrator internals lets us reuse the same flow across providers and
// across future orchestrator refactors.

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
    console.log(tag, `visit ${i + 1}/${links.length}`, { title, href: link.href });
    await opts.reportPatch({ currentTitle: title });

    const before = await readLastDownload();
    let outcome: BackfillLogEntry;
    try {
      await adapter.navigate(link);
      const advanced = await waitForOurDownload(
        adapter,
        before,
        opts.perChatTimeoutMs,
        pollIntervalMs,
      );
      if (advanced) {
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
          reason: 'no download captured within timeout (cached / out-of-range / empty)',
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
