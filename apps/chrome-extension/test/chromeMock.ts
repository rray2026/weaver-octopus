// Lightweight chrome.* surface mock for unit tests. Each test grabs a fresh
// instance via `installChromeMock()` and the storage map starts empty.
import { vi } from 'vitest';

export interface StorageChange<T = unknown> {
  oldValue?: T;
  newValue?: T;
}

export type StorageChangeListener = (
  changes: Record<string, StorageChange>,
  areaName: 'local' | 'sync' | 'managed' | 'session',
) => void;

export interface ChromeMock {
  storage: {
    local: Record<string, unknown>;
    listeners: Set<StorageChangeListener>;
  };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
  };
  downloads: {
    download: ReturnType<typeof vi.fn>;
  };
}

export function installChromeMock(): ChromeMock {
  const storageData: Record<string, unknown> = {};
  const listeners = new Set<StorageChangeListener>();

  const fireChanges = (changes: Record<string, StorageChange>) => {
    for (const cb of listeners) cb(changes, 'local');
  };

  const chromeStub = {
    storage: {
      local: {
        async get(key?: string | string[] | null) {
          if (key == null) return { ...storageData };
          if (typeof key === 'string') {
            return key in storageData ? { [key]: storageData[key] } : {};
          }
          const out: Record<string, unknown> = {};
          for (const k of key) if (k in storageData) out[k] = storageData[k];
          return out;
        },
        async set(items: Record<string, unknown>) {
          const changes: Record<string, StorageChange> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: storageData[k], newValue: v };
            storageData[k] = v;
          }
          fireChanges(changes);
        },
        async remove(keys: string | string[]) {
          const arr = typeof keys === 'string' ? [keys] : keys;
          const changes: Record<string, StorageChange> = {};
          for (const k of arr) {
            if (k in storageData) {
              changes[k] = { oldValue: storageData[k], newValue: undefined };
              delete storageData[k];
            }
          }
          if (Object.keys(changes).length > 0) fireChanges(changes);
        },
      },
      onChanged: {
        addListener: (cb: StorageChangeListener) => listeners.add(cb),
        removeListener: (cb: StorageChangeListener) => listeners.delete(cb),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    downloads: {
      download: vi.fn(async () => 1),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).chrome = chromeStub;

  return {
    storage: { local: storageData, listeners },
    runtime: chromeStub.runtime,
    downloads: chromeStub.downloads,
  };
}

export function uninstallChromeMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).chrome;
}
