// Mirrors src/dateFilter.test.ts — content-script copy must stay in sync.
// See content/dateFilter.ts for why the file is duplicated.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRange, loadFilter } from './dateFilter.js';
import { installChromeMock, uninstallChromeMock } from '../../test/chromeMock.js';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe('content/dateFilter.computeRange', () => {
  it('today', () => {
    const r = computeRange({ type: 'today' }, at(2026, 4, 29));
    expect(new Date(r.start)).toEqual(at(2026, 4, 29, 0));
    expect(new Date(r.end)).toEqual(at(2026, 4, 30, 0));
  });

  it('yesterday', () => {
    const r = computeRange({ type: 'yesterday' }, at(2026, 4, 29));
    expect(new Date(r.start)).toEqual(at(2026, 4, 28, 0));
    expect(new Date(r.end)).toEqual(at(2026, 4, 29, 0));
  });

  it('last7days spans 7 days inclusive of today', () => {
    const r = computeRange({ type: 'last7days' }, at(2026, 4, 29));
    expect(new Date(r.start)).toEqual(at(2026, 4, 23, 0));
    expect(new Date(r.end)).toEqual(at(2026, 4, 30, 0));
  });

  it('thisWeek on Sunday stays in the same ISO week', () => {
    const r = computeRange({ type: 'thisWeek' }, at(2026, 5, 3));
    expect(new Date(r.start)).toEqual(at(2026, 4, 27, 0));
    expect(new Date(r.end)).toEqual(at(2026, 5, 4, 0));
  });

  it('range inclusive of end day', () => {
    const r = computeRange(
      { type: 'range', start: '2026-04-20', end: '2026-04-25' },
      at(2026, 4, 29),
    );
    expect(new Date(r.start)).toEqual(at(2026, 4, 20, 0));
    expect(new Date(r.end)).toEqual(at(2026, 4, 26, 0));
  });
});

describe('content/dateFilter.loadFilter', () => {
  beforeEach(() => installChromeMock());
  afterEach(() => uninstallChromeMock());

  it('defaults to today when storage empty', async () => {
    expect(await loadFilter()).toEqual({ type: 'today' });
  });

  it('returns valid stored filter', async () => {
    await chrome.storage.local.set({
      dateFilter: { type: 'range', start: '2026-04-01', end: '2026-04-15' },
    });
    expect(await loadFilter()).toEqual({
      type: 'range',
      start: '2026-04-01',
      end: '2026-04-15',
    });
  });

  it('falls back to default for invalid stored value', async () => {
    await chrome.storage.local.set({ dateFilter: { type: 'banana' } });
    expect(await loadFilter()).toEqual({ type: 'today' });
  });
});
