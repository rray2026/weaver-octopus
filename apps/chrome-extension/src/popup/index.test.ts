// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../../test/chromeMock.js';
import type { DateFilter, LastDownload } from '../types/index.js';

const STORAGE_KEY = 'dateFilter';
const LAST_DOWNLOAD_KEY = 'lastDownload';
const HASH_KEY = 'convHashes';

// Minimal subset of popup.html — only the IDs popup/index.ts queries. Loading
// the real file would also bring in the inline <style>, which jsdom doesn't
// need to evaluate to test behavior.
const POPUP_DOM = `
  <div id="shortcuts">
    <button data-type="today">今天</button>
    <button data-type="yesterday">昨天</button>
    <button data-type="last7days">近 7 天</button>
    <button data-type="thisWeek">本周</button>
    <button data-type="range">自定义</button>
  </div>
  <div id="range-row" hidden>
    <input type="date" id="start-date" />
    <input type="date" id="end-date" />
  </div>
  <p id="status">Loading…</p>
  <span id="cache-count"></span>
  <button id="reset-btn" type="button">Reset cache</button>
`;

async function loadPopup(): Promise<void> {
  document.body.innerHTML = POPUP_DOM;
  vi.resetModules();
  await import('./index.js');
  // popup/index.ts calls init() at module top-level; let its async work settle
  // before tests poke at the DOM.
  await flushAsync();
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function clickShortcut(type: DateFilter['type']): void {
  const btn = document.querySelector<HTMLButtonElement>(`button[data-type="${type}"]`);
  if (!btn) throw new Error(`shortcut button missing: ${type}`);
  btn.click();
}

describe('popup', () => {
  let mock: ChromeMock;
  let originalConfirm: typeof window.confirm;
  let confirmFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mock = installChromeMock();
    originalConfirm = window.confirm;
    confirmFn = vi.fn(() => true);
    window.confirm = confirmFn as unknown as typeof window.confirm;
  });

  afterEach(() => {
    uninstallChromeMock();
    window.confirm = originalConfirm;
    document.body.innerHTML = '';
  });

  it('renders the active filter (today by default) and marks the "今天" button active', async () => {
    await loadPopup();

    const todayBtn = document.querySelector<HTMLButtonElement>('button[data-type="today"]')!;
    expect(todayBtn.classList.contains('active')).toBe(true);

    const status = document.getElementById('status')!;
    expect(status.textContent).toMatch(/Filter: \d{4}-\d{2}-\d{2}/);
    expect(status.textContent).toMatch(/No downloads yet/);
  });

  it('shows the previously stored filter on open', async () => {
    mock.storage.local[STORAGE_KEY] = { type: 'last7days' } satisfies DateFilter;
    await loadPopup();

    const last7 = document.querySelector<HTMLButtonElement>('button[data-type="last7days"]')!;
    const today = document.querySelector<HTMLButtonElement>('button[data-type="today"]')!;
    expect(last7.classList.contains('active')).toBe(true);
    expect(today.classList.contains('active')).toBe(false);
  });

  it('writes the new filter to chrome.storage.local when a shortcut is clicked', async () => {
    await loadPopup();

    clickShortcut('yesterday');
    await flushAsync();

    expect(mock.storage.local[STORAGE_KEY]).toEqual({ type: 'yesterday' });
    const yesterdayBtn = document.querySelector<HTMLButtonElement>(
      'button[data-type="yesterday"]',
    )!;
    expect(yesterdayBtn.classList.contains('active')).toBe(true);
  });

  it('reveals the date inputs when "自定义" is selected', async () => {
    await loadPopup();
    const rangeRow = document.getElementById('range-row') as HTMLElement;
    expect(rangeRow.hidden).toBe(true);

    clickShortcut('range');
    await flushAsync();

    expect(rangeRow.hidden).toBe(false);
    const stored = mock.storage.local[STORAGE_KEY] as DateFilter;
    expect(stored.type).toBe('range');
    expect(stored.start).toBeTruthy();
    expect(stored.end).toBeTruthy();
  });

  it('persists a custom range when both date inputs change', async () => {
    await loadPopup();
    clickShortcut('range');
    await flushAsync();

    const start = document.getElementById('start-date') as HTMLInputElement;
    const end = document.getElementById('end-date') as HTMLInputElement;
    start.value = '2026-04-01';
    end.value = '2026-04-15';
    start.dispatchEvent(new Event('change'));
    end.dispatchEvent(new Event('change'));
    await flushAsync();

    expect(mock.storage.local[STORAGE_KEY]).toEqual({
      type: 'range',
      start: '2026-04-01',
      end: '2026-04-15',
    });
  });

  it('renders the last download line when storage has one', async () => {
    const last: LastDownload = {
      filename: 'weaver-octopus/2026-04-30/[claude] Hello-abcdef12.md',
      at: Date.parse('2026-04-30T10:00:00Z'),
    };
    mock.storage.local[LAST_DOWNLOAD_KEY] = last;
    mock.storage.local[HASH_KEY] = { 'conv-1': 'h1', 'conv-2': 'h2' };

    await loadPopup();

    const status = document.getElementById('status')!;
    expect(status.textContent).toContain('Hello-abcdef12.md');
    expect(document.getElementById('cache-count')!.textContent).toBe('2 chat(s) cached.');
  });

  it('Reset clears convHashes + lastDownload after the user confirms', async () => {
    mock.storage.local[LAST_DOWNLOAD_KEY] = {
      filename: 'x.md',
      at: 123,
    } satisfies LastDownload;
    mock.storage.local[HASH_KEY] = { c1: 'h' };

    await loadPopup();

    (document.getElementById('reset-btn') as HTMLButtonElement).click();
    await flushAsync();

    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(mock.storage.local[LAST_DOWNLOAD_KEY]).toBeUndefined();
    expect(mock.storage.local[HASH_KEY]).toBeUndefined();
    expect(document.getElementById('cache-count')!.textContent).toBe('No cached chats.');
  });

  it('Reset is a no-op when the user cancels the confirm dialog', async () => {
    mock.storage.local[LAST_DOWNLOAD_KEY] = {
      filename: 'keep.md',
      at: 1,
    } satisfies LastDownload;
    mock.storage.local[HASH_KEY] = { c1: 'h' };

    confirmFn.mockReturnValue(false);
    await loadPopup();
    (document.getElementById('reset-btn') as HTMLButtonElement).click();
    await flushAsync();

    expect(mock.storage.local[LAST_DOWNLOAD_KEY]).toEqual({ filename: 'keep.md', at: 1 });
    expect(mock.storage.local[HASH_KEY]).toEqual({ c1: 'h' });
  });
});
