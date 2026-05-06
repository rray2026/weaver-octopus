import { describe, expect, it, vi } from 'vitest';

async function freshImport(): Promise<typeof import('./backfill-gate.js')> {
  vi.resetModules();
  return import('./backfill-gate.js');
}

describe('backfill-gate', () => {
  it('starts false', async () => {
    const m = await freshImport();
    expect(m.isBackfillInFlight()).toBe(false);
  });

  it('flips on / off via setBackfillInFlight', async () => {
    const m = await freshImport();
    m.setBackfillInFlight(true);
    expect(m.isBackfillInFlight()).toBe(true);
    m.setBackfillInFlight(false);
    expect(m.isBackfillInFlight()).toBe(false);
  });

  it('module state is per-tab — a fresh import resets to false', async () => {
    const m1 = await freshImport();
    m1.setBackfillInFlight(true);
    const m2 = await freshImport();
    expect(m2.isBackfillInFlight()).toBe(false);
  });
});
