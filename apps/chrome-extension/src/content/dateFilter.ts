// Content-script-local copy of the date-filter logic. Kept duplicated from
// src/dateFilter.ts because content scripts are injected as classic scripts
// (no ES modules), so Rollup must inline this code into content.js rather
// than emit a shared chunk.
import type { DateFilter, DateFilterType } from '../types/index.js';

const STORAGE_KEY = 'dateFilter';
const DEFAULT_FILTER: DateFilter = { type: 'today' };
const VALID_TYPES: DateFilterType[] = ['today', 'yesterday', 'last7days', 'thisWeek', 'range'];

export async function loadFilter(): Promise<DateFilter> {
  const items = await chrome.storage.local.get(STORAGE_KEY);
  const raw = items[STORAGE_KEY];
  return isValidFilter(raw) ? raw : DEFAULT_FILTER;
}

export interface DateRange {
  start: number;
  end: number;
  label: string;
}

export function computeRange(filter: DateFilter, now: Date): DateRange {
  const today = startOfDay(now);
  switch (filter.type) {
    case 'today': {
      const end = addDays(today, 1);
      return { start: today.getTime(), end: end.getTime(), label: dateLabel(today) };
    }
    case 'yesterday': {
      const start = addDays(today, -1);
      return { start: start.getTime(), end: today.getTime(), label: dateLabel(start) };
    }
    case 'last7days': {
      const start = addDays(today, -6);
      const end = addDays(today, 1);
      return {
        start: start.getTime(),
        end: end.getTime(),
        label: `${dateLabel(start)} → ${dateLabel(today)}`,
      };
    }
    case 'thisWeek': {
      const dow = today.getDay() || 7;
      const monday = addDays(today, -(dow - 1));
      const sunday = addDays(monday, 6);
      const nextMonday = addDays(monday, 7);
      return {
        start: monday.getTime(),
        end: nextMonday.getTime(),
        label: `${dateLabel(monday)} → ${dateLabel(sunday)}`,
      };
    }
    case 'range': {
      const startDay = filter.start ? parseLocalDate(filter.start) : today;
      const endDay = filter.end ? parseLocalDate(filter.end) : today;
      const inclusiveEnd = endDay >= startDay ? endDay : startDay;
      const end = addDays(inclusiveEnd, 1);
      return {
        start: startDay.getTime(),
        end: end.getTime(),
        label: `${dateLabel(startDay)} → ${dateLabel(inclusiveEnd)}`,
      };
    }
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function parseLocalDate(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function dateLabel(d: Date): string {
  return d.toLocaleDateString('en-CA');
}
function isValidFilter(raw: unknown): raw is DateFilter {
  if (!raw || typeof raw !== 'object') return false;
  const f = raw as { type?: unknown };
  return typeof f.type === 'string' && (VALID_TYPES as string[]).includes(f.type);
}
