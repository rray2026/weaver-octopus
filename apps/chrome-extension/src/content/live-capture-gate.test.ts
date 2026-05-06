// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../test/chromeMock.js';

async function freshImport(): Promise<typeof import('./live-capture-gate.js')> {
  vi.resetModules();
  return import('./live-capture-gate.js');
}

describe('live-capture-gate', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  it('denies by default when storage has no preference', async () => {
    const m = await freshImport();
    expect(await m.isLiveCaptureAllowed()).toBe(false);
  });

  it('allows when liveCaptureEnabled is true in storage', async () => {
    mock.storage.local['liveCaptureEnabled'] = true;
    const m = await freshImport();
    expect(await m.isLiveCaptureAllowed()).toBe(true);
  });

  it('allows when backfill is in flight, even with toggle off', async () => {
    const m = await freshImport();
    m.setBackfillInFlight(true);
    expect(await m.isLiveCaptureAllowed()).toBe(true);
    m.setBackfillInFlight(false);
    expect(await m.isLiveCaptureAllowed()).toBe(false);
  });

  it('reacts to live storage changes (no reload required)', async () => {
    const m = await freshImport();
    expect(await m.isLiveCaptureAllowed()).toBe(false);

    // Simulate the popup toggling the flag.
    for (const cb of mock.storage.listeners) {
      cb({ liveCaptureEnabled: { newValue: true } }, 'local');
    }
    expect(await m.isLiveCaptureAllowed()).toBe(true);

    for (const cb of mock.storage.listeners) {
      cb({ liveCaptureEnabled: { newValue: false } }, 'local');
    }
    expect(await m.isLiveCaptureAllowed()).toBe(false);
  });

  it('does not react to changes in unrelated keys', async () => {
    const m = await freshImport();
    for (const cb of mock.storage.listeners) {
      cb({ someOtherKey: { newValue: true } }, 'local');
    }
    expect(await m.isLiveCaptureAllowed()).toBe(false);
  });

  it('treats non-boolean truthy values as false (only strict true allows)', async () => {
    mock.storage.local['liveCaptureEnabled'] = 'true'; // string, not boolean
    const m = await freshImport();
    expect(await m.isLiveCaptureAllowed()).toBe(false);
  });
});
