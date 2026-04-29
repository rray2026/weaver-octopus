import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeRange,
  DEFAULT_FILTER,
  loadFilter,
  saveFilter,
} from './dateFilter.js';
import type { DateFilter } from './types/index.js';
import { installChromeMock, uninstallChromeMock } from '../test/chromeMock.js';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe('computeRange', () => {
  describe('today', () => {
    it('returns [start of today, start of tomorrow)', () => {
      const now = at(2026, 4, 29, 14);
      const r = computeRange({ type: 'today' }, now);
      expect(new Date(r.start)).toEqual(at(2026, 4, 29, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 30, 0));
      expect(r.label).toBe('2026-04-29');
    });
  });

  describe('yesterday', () => {
    it('returns [yesterday 00:00, today 00:00)', () => {
      const r = computeRange({ type: 'yesterday' }, at(2026, 4, 29, 14));
      expect(new Date(r.start)).toEqual(at(2026, 4, 28, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 29, 0));
      expect(r.label).toBe('2026-04-28');
    });

    it('handles month boundary', () => {
      const r = computeRange({ type: 'yesterday' }, at(2026, 5, 1));
      expect(new Date(r.start)).toEqual(at(2026, 4, 30, 0));
      expect(new Date(r.end)).toEqual(at(2026, 5, 1, 0));
    });
  });

  describe('last7days', () => {
    it('returns 7-day window ending tomorrow 00:00', () => {
      const r = computeRange({ type: 'last7days' }, at(2026, 4, 29));
      expect(new Date(r.start)).toEqual(at(2026, 4, 23, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 30, 0));
      expect(r.label).toBe('2026-04-23 → 2026-04-29');
    });
  });

  describe('thisWeek', () => {
    it('Wednesday → Mon..Sun of same week', () => {
      // 2026-04-29 is a Wednesday.
      const r = computeRange({ type: 'thisWeek' }, at(2026, 4, 29));
      expect(new Date(r.start)).toEqual(at(2026, 4, 27, 0)); // Mon
      expect(new Date(r.end)).toEqual(at(2026, 5, 4, 0)); // next Mon (exclusive)
      expect(r.label).toBe('2026-04-27 → 2026-05-03');
    });

    it('Sunday counts toward the week that just ended (dow=0 → 7)', () => {
      // 2026-05-03 is Sunday — getDay() returns 0, must coerce to 7
      const r = computeRange({ type: 'thisWeek' }, at(2026, 5, 3));
      expect(new Date(r.start)).toEqual(at(2026, 4, 27, 0));
      expect(new Date(r.end)).toEqual(at(2026, 5, 4, 0));
      expect(r.label).toBe('2026-04-27 → 2026-05-03');
    });

    it('Monday → starts that day', () => {
      const r = computeRange({ type: 'thisWeek' }, at(2026, 4, 27));
      expect(new Date(r.start)).toEqual(at(2026, 4, 27, 0));
      expect(new Date(r.end)).toEqual(at(2026, 5, 4, 0));
    });
  });

  describe('range', () => {
    it('inclusive end day: end day messages are kept', () => {
      const r = computeRange(
        { type: 'range', start: '2026-04-20', end: '2026-04-25' },
        at(2026, 4, 29),
      );
      expect(new Date(r.start)).toEqual(at(2026, 4, 20, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 26, 0)); // end day + 1
      expect(r.label).toBe('2026-04-20 → 2026-04-25');
    });

    it('end before start: clamps end to start day', () => {
      const r = computeRange(
        { type: 'range', start: '2026-04-25', end: '2026-04-20' },
        at(2026, 4, 29),
      );
      expect(new Date(r.start)).toEqual(at(2026, 4, 25, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 26, 0));
      expect(r.label).toBe('2026-04-25 → 2026-04-25');
    });

    it('missing start/end falls back to today', () => {
      const r = computeRange({ type: 'range' }, at(2026, 4, 29));
      expect(new Date(r.start)).toEqual(at(2026, 4, 29, 0));
      expect(new Date(r.end)).toEqual(at(2026, 4, 30, 0));
    });
  });
});

describe('loadFilter / saveFilter', () => {
  beforeEach(() => installChromeMock());
  afterEach(() => uninstallChromeMock());

  it('returns DEFAULT_FILTER when storage is empty', async () => {
    expect(await loadFilter()).toEqual(DEFAULT_FILTER);
  });

  it('round-trips a saved filter', async () => {
    const f: DateFilter = { type: 'range', start: '2026-04-01', end: '2026-04-15' };
    await saveFilter(f);
    expect(await loadFilter()).toEqual(f);
  });

  it('rejects malformed stored values and returns default', async () => {
    await saveFilter({ type: 'not-a-real-type' as never });
    expect(await loadFilter()).toEqual(DEFAULT_FILTER);
  });

  it('rejects non-object stored values', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await chrome.storage.local.set({ dateFilter: 'garbage' as any });
    expect(await loadFilter()).toEqual(DEFAULT_FILTER);
  });
});
