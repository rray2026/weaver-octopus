import { computeRange, loadFilter, saveFilter } from '../dateFilter.js';
import type { DateFilter, DateFilterType, LastDownload } from '../types/index.js';

const LAST_DOWNLOAD_KEY = 'lastDownload';
const HASH_STORAGE_KEY = 'convHashes';

async function init(): Promise<void> {
  const statusEl = document.getElementById('status');
  const shortcutsEl = document.getElementById('shortcuts');
  const rangeRow = document.getElementById('range-row');
  const startInput = document.getElementById('start-date') as HTMLInputElement | null;
  const endInput = document.getElementById('end-date') as HTMLInputElement | null;
  const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement | null;
  const cacheCountEl = document.getElementById('cache-count');
  if (!statusEl || !shortcutsEl || !rangeRow || !startInput || !endInput || !resetBtn || !cacheCountEl) return;

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

  await renderStatus(statusEl, cacheCountEl);
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

init();
