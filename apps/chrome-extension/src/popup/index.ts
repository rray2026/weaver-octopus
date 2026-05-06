import { computeRange, loadFilter, saveFilter } from '../dateFilter.js';
import { startDevForwarder } from '@weaver-octopus/ext-dev-rpc/popup';
import type {
  BackfillProgress,
  BackfillProviderProgress,
  ClaudeCaptureMode,
  DateFilter,
  DateFilterType,
  LastDownload,
  Provider,
} from '../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const HASH_STORAGE_KEY = 'convHashes';
const BACKFILL_PROGRESS_KEY = 'backfillProgress';
const CLAUDE_CAPTURE_MODE_KEY = 'claudeCaptureMode';
const BACKFILL_INTERVAL_KEY = 'backfillIntervalSec';
const DEFAULT_INTERVAL_MIN_SEC = 4;
const DEFAULT_INTERVAL_MAX_SEC = 6;
const INTERVAL_HARD_MIN_SEC = 0;
const INTERVAL_HARD_MAX_SEC = 600;

async function init(): Promise<void> {
  const statusEl = document.getElementById('status');
  const shortcutsEl = document.getElementById('shortcuts');
  const rangeRow = document.getElementById('range-row');
  const startInput = document.getElementById('start-date') as HTMLInputElement | null;
  const endInput = document.getElementById('end-date') as HTMLInputElement | null;
  const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement | null;
  const cacheCountEl = document.getElementById('cache-count');
  const backfillStartBtn = document.getElementById('backfill-start') as HTMLButtonElement | null;
  const backfillStopBtn = document.getElementById('backfill-stop') as HTMLButtonElement | null;
  const backfillStateEl = document.getElementById('backfill-state');
  const progressBlock = document.getElementById('progress-block');
  const progressProviders = document.getElementById('progress-providers');
  const logList = document.getElementById('log-list');
  const claudeCheck = document.getElementById('provider-claude') as HTMLInputElement | null;
  const geminiCheck = document.getElementById('provider-gemini') as HTMLInputElement | null;
  if (
    !statusEl ||
    !shortcutsEl ||
    !rangeRow ||
    !startInput ||
    !endInput ||
    !resetBtn ||
    !cacheCountEl ||
    !backfillStartBtn ||
    !backfillStopBtn ||
    !backfillStateEl ||
    !progressBlock ||
    !progressProviders ||
    !logList ||
    !claudeCheck ||
    !geminiCheck
  )
    return;

  const today = new Date().toLocaleDateString('en-CA');
  const filter = await loadFilter();

  // Seed inputs with the active range (so switching to "自定义" shows something).
  const seededRange = computeRange(filter, new Date());
  if (filter.type === 'range') {
    startInput.value = filter.start ?? today;
    endInput.value = filter.end ?? today;
  } else {
    startInput.value = isoFromMs(seededRange.start);
    endInput.value = isoFromMs(seededRange.end - 1);
  }

  applyFilterToUi(filter, shortcutsEl, rangeRow);

  shortcutsEl.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset['type'] as DateFilterType;
      const next: DateFilter =
        type === 'range'
          ? { type, start: startInput.value || today, end: endInput.value || today }
          : { type };
      await saveFilter(next);
      applyFilterToUi(next, shortcutsEl, rangeRow);
      await renderStatus(statusEl, cacheCountEl);
    });
  });

  const onRangeChange = async () => {
    if (!startInput.value || !endInput.value) return;
    const next: DateFilter = {
      type: 'range',
      start: startInput.value,
      end: endInput.value,
    };
    await saveFilter(next);
    applyFilterToUi(next, shortcutsEl, rangeRow);
    await renderStatus(statusEl, cacheCountEl);
  };
  startInput.addEventListener('change', onRangeChange);
  endInput.addEventListener('change', onRangeChange);

  resetBtn.addEventListener('click', async () => {
    if (!confirm('Clear download cache? Next visit to each chat will re-download.')) return;
    resetBtn.disabled = true;
    try {
      await chrome.storage.local.remove([HASH_STORAGE_KEY, LAST_DOWNLOAD_KEY]);
      await renderStatus(statusEl, cacheCountEl);
    } finally {
      resetBtn.disabled = false;
    }
  });

  // ─── Claude capture mode (intercept | fetch) ─────────────────────────────

  await initClaudeMode();

  // ─── Backfill interval inputs (per-chat random sleep range, in seconds) ──

  const intervalMinInput = document.getElementById('interval-min') as HTMLInputElement | null;
  const intervalMaxInput = document.getElementById('interval-max') as HTMLInputElement | null;
  await initIntervalInputs(intervalMinInput, intervalMaxInput);

  // ─── Backfill wiring ──────────────────────────────────────────────────────

  backfillStartBtn.addEventListener('click', async () => {
    const providers: Provider[] = [];
    if (claudeCheck.checked) providers.push('claude');
    if (geminiCheck.checked) providers.push('gemini');
    if (providers.length === 0) {
      alert('请至少勾选一个 provider');
      return;
    }
    const interval = readIntervalFromInputs(intervalMinInput, intervalMaxInput);
    backfillStartBtn.disabled = true;
    try {
      const ack = await chrome.runtime.sendMessage({
        type: 'START_BACKFILL',
        providers,
        intervalMinSec: interval.minSec,
        intervalMaxSec: interval.maxSec,
      });
      if (!ack?.ok) {
        alert(`无法开始：${ack?.error ?? 'unknown error'}`);
      }
    } finally {
      // Re-enabling is governed by progress state below.
      await renderBackfill();
    }
  });

  backfillStopBtn.addEventListener('click', async () => {
    backfillStopBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_BACKFILL' });
    } finally {
      await renderBackfill();
    }
  });

  // Capture into locals with non-null types — the closure below otherwise
  // doesn't see the narrowing from the early-return guard above.
  const startBtn = backfillStartBtn;
  const stopBtn = backfillStopBtn;
  const stateEl = backfillStateEl;
  const block = progressBlock;
  const providersEl = progressProviders;
  const logEl = logList;

  // Live update on storage changes (background writes progress there).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[BACKFILL_PROGRESS_KEY]) void renderBackfill();
    if (changes[LAST_DOWNLOAD_KEY] || changes[HASH_STORAGE_KEY]) {
      void renderStatus(statusEl, cacheCountEl);
    }
  });

  await renderStatus(statusEl, cacheCountEl);
  await renderBackfill();

  async function renderBackfill(): Promise<void> {
    const items = await chrome.storage.local.get(BACKFILL_PROGRESS_KEY);
    const prog = items[BACKFILL_PROGRESS_KEY] as BackfillProgress | undefined;
    const isRunning = prog?.state === 'running' || prog?.state === 'stopping';

    startBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    stateEl.textContent = stateLabel(prog?.state);

    if (!prog || prog.state === 'idle') {
      block.hidden = true;
      providersEl.innerHTML = '';
      logEl.innerHTML = '';
      return;
    }
    block.hidden = false;
    providersEl.innerHTML = '';
    const providers = Object.keys(prog.perProvider) as Provider[];
    for (const p of providers) {
      const pp = prog.perProvider[p];
      if (!pp) continue;
      providersEl.appendChild(makeProviderRow(p, pp));
    }
    renderLog(logEl, prog);
  }

  async function initIntervalInputs(
    minInput: HTMLInputElement | null,
    maxInput: HTMLInputElement | null,
  ): Promise<void> {
    if (!minInput || !maxInput) return;
    const stored = await chrome.storage.local.get(BACKFILL_INTERVAL_KEY);
    const raw = stored[BACKFILL_INTERVAL_KEY] as
      | { minSec?: number; maxSec?: number }
      | undefined;
    const seeded = sanitizeInterval(raw?.minSec, raw?.maxSec);
    minInput.value = String(seeded.minSec);
    maxInput.value = String(seeded.maxSec);
    const persist = async (): Promise<void> => {
      const cur = readIntervalFromInputs(minInput, maxInput);
      // Reflect the clamped values back into the inputs so the user sees
      // exactly what got persisted (e.g. swap if min > max).
      minInput.value = String(cur.minSec);
      maxInput.value = String(cur.maxSec);
      await chrome.storage.local.set({ [BACKFILL_INTERVAL_KEY]: cur });
    };
    minInput.addEventListener('change', persist);
    maxInput.addEventListener('change', persist);
  }

  async function initClaudeMode(): Promise<void> {
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="claude-mode"]'),
    );
    if (radios.length === 0) return;
    const stored = await chrome.storage.local.get(CLAUDE_CAPTURE_MODE_KEY);
    const current: ClaudeCaptureMode =
      stored[CLAUDE_CAPTURE_MODE_KEY] === 'fetch' ? 'fetch' : 'intercept';
    for (const r of radios) r.checked = r.value === current;
    for (const r of radios) {
      r.addEventListener('change', async () => {
        if (!r.checked) return;
        const next = r.value === 'fetch' ? 'fetch' : 'intercept';
        await chrome.storage.local.set({ [CLAUDE_CAPTURE_MODE_KEY]: next });
      });
    }
  }
}

function stateLabel(state: BackfillProgress['state'] | undefined): string {
  if (!state || state === 'idle') return '';
  if (state === 'running') return '运行中…';
  if (state === 'stopping') return '正在停止…';
  if (state === 'done') return '已完成';
  if (state === 'error') return '出错';
  return state;
}

function makeProviderRow(provider: Provider, pp: BackfillProviderProgress): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '6px';
  const top = document.createElement('div');
  top.className = 'progress-row';
  const total = Math.max(pp.total, 1);
  const completed = pp.done + pp.failed + pp.skipped;
  const pct = pp.total === 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
  const label = document.createElement('span');
  label.style.minWidth = '90px';
  label.textContent = `${provider}: ${completed}/${pp.total}`;
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('span');
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  top.appendChild(label);
  top.appendChild(bar);
  wrap.appendChild(top);

  const detail = document.createElement('div');
  detail.style.fontSize = '10px';
  detail.style.color = '#888';
  detail.style.marginTop = '2px';
  const parts: string[] = [];
  if (pp.done > 0) parts.push(`✓ ${pp.done}`);
  if (pp.skipped > 0) parts.push(`⤼ ${pp.skipped} 跳过`);
  if (pp.failed > 0) parts.push(`✗ ${pp.failed} 失败`);
  if (pp.currentTitle) parts.push(`正在: ${truncate(pp.currentTitle, 30)}`);
  detail.textContent = parts.join('  ·  ');
  wrap.appendChild(detail);
  return wrap;
}

function renderLog(logEl: HTMLElement, prog: BackfillProgress): void {
  logEl.innerHTML = '';
  const all = (Object.keys(prog.perProvider) as Provider[])
    .flatMap((p) => prog.perProvider[p]?.log ?? [])
    .sort((a, b) => b.at - a.at);
  if (all.length === 0) {
    logEl.textContent = '(暂无日志)';
    return;
  }
  for (const entry of all.slice(0, 80)) {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.status}`;
    const time = new Date(entry.at).toLocaleTimeString();
    const sym =
      entry.status === 'ok' ? '✓' : entry.status === 'skipped' ? '⤼' : '✗';
    const title = entry.title ? truncate(entry.title, 50) : entry.href ?? '(unknown)';
    const reason = entry.reason ? ` — ${entry.reason}` : '';
    div.textContent = `${time} ${sym} [${entry.provider}] ${title}${reason}`;
    logEl.appendChild(div);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function applyFilterToUi(
  filter: DateFilter,
  shortcutsEl: HTMLElement,
  rangeRow: HTMLElement,
): void {
  shortcutsEl.querySelectorAll<HTMLButtonElement>('button[data-type]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset['type'] === filter.type);
  });
  rangeRow.hidden = filter.type !== 'range';
}

async function renderStatus(statusEl: HTMLElement, cacheCountEl: HTMLElement): Promise<void> {
  try {
    const filter = await loadFilter();
    const range = computeRange(filter, new Date());
    const items = await chrome.storage.local.get([LAST_DOWNLOAD_KEY, HASH_STORAGE_KEY]);
    const last = items[LAST_DOWNLOAD_KEY] as LastDownload | undefined;
    const hashes = items[HASH_STORAGE_KEY] as Record<string, string> | undefined;
    const cachedCount = hashes ? Object.keys(hashes).length : 0;
    const lastLine = last
      ? `Last: ${last.filename} (${new Date(last.at).toLocaleString()})`
      : 'No downloads yet. Open a chat on claude.ai.';
    statusEl.innerHTML = '';
    statusEl.appendChild(makeLine(`Filter: ${range.label}`));
    statusEl.appendChild(makeLine(lastLine));
    cacheCountEl.textContent =
      cachedCount === 0 ? 'No cached chats.' : `${cachedCount} chat(s) cached.`;
  } catch (err) {
    console.error('[weaver] popup status failed', err);
    statusEl.textContent = 'Error loading status.';
  }
}

function makeLine(text: string): HTMLElement {
  const div = document.createElement('div');
  div.textContent = text;
  return div;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA');
}

/** Reads min/max seconds out of the two number inputs, sanitises them
 *  (clamp to [0, 600], swap if reversed, NaN → defaults) and returns the
 *  cleaned pair. Used both for persistence on change and right before
 *  START_BACKFILL is dispatched. */
export function readIntervalFromInputs(
  minInput: HTMLInputElement | null,
  maxInput: HTMLInputElement | null,
): { minSec: number; maxSec: number } {
  const rawMin = minInput ? parseFloat(minInput.value) : NaN;
  const rawMax = maxInput ? parseFloat(maxInput.value) : NaN;
  return sanitizeInterval(rawMin, rawMax);
}

export function sanitizeInterval(
  rawMin: number | undefined,
  rawMax: number | undefined,
): { minSec: number; maxSec: number } {
  let minSec = Number.isFinite(rawMin) ? (rawMin as number) : DEFAULT_INTERVAL_MIN_SEC;
  let maxSec = Number.isFinite(rawMax) ? (rawMax as number) : DEFAULT_INTERVAL_MAX_SEC;
  minSec = Math.max(INTERVAL_HARD_MIN_SEC, Math.min(INTERVAL_HARD_MAX_SEC, minSec));
  maxSec = Math.max(INTERVAL_HARD_MIN_SEC, Math.min(INTERVAL_HARD_MAX_SEC, maxSec));
  if (maxSec < minSec) [minSec, maxSec] = [maxSec, minSec];
  return { minSec, maxSec };
}

if (__WEAVER_DEV__) startDevForwarder('popup');
init();
