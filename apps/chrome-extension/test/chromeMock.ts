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

export type RuntimeMessageListener = (
  message: unknown,
  sender: { tab?: { url?: string; id?: number } },
  sendResponse: (response?: unknown) => void,
) => boolean | void;

export type DownloadChangeListener = (delta: {
  id: number;
  state?: { current: string };
  error?: { current: string };
}) => void;

export type RuntimeInstalledListener = (details: { reason: string }) => void;

export type TabsRemovedListener = (
  tabId: number,
  removeInfo: { windowId: number; isWindowClosing: boolean },
) => void;

interface MockManifest {
  host_permissions?: string[];
  [key: string]: unknown;
}

export interface ChromeMock {
  storage: {
    local: Record<string, unknown>;
    listeners: Set<StorageChangeListener>;
  };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    messageListeners: Set<RuntimeMessageListener>;
    installedListeners: Set<RuntimeInstalledListener>;
    manifest: MockManifest;
  };
  downloads: {
    download: ReturnType<typeof vi.fn>;
    changeListeners: Set<DownloadChangeListener>;
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    removedListeners: Set<TabsRemovedListener>;
  };
  storageSession: {
    data: Record<string, unknown>;
  };
}

export interface ChromeMockOptions {
  /** Manifest returned from chrome.runtime.getManifest(). Defaults to host_permissions=['https://claude.ai/*']. */
  manifest?: MockManifest;
}

const DEFAULT_MANIFEST: MockManifest = {
  host_permissions: ['https://claude.ai/*'],
};

export function installChromeMock(options: ChromeMockOptions = {}): ChromeMock {
  const storageData: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  const storageListeners = new Set<StorageChangeListener>();
  const messageListeners = new Set<RuntimeMessageListener>();
  const installedListeners = new Set<RuntimeInstalledListener>();
  const downloadChangeListeners = new Set<DownloadChangeListener>();
  const tabsRemovedListeners = new Set<TabsRemovedListener>();
  const manifest: MockManifest = options.manifest ?? DEFAULT_MANIFEST;

  const fireStorageChanges = (changes: Record<string, StorageChange>) => {
    for (const cb of storageListeners) cb(changes, 'local');
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
          fireStorageChanges(changes);
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
          if (Object.keys(changes).length > 0) fireStorageChanges(changes);
        },
      },
      session: {
        async get(key?: string | string[] | null) {
          if (key == null) return { ...sessionData };
          if (typeof key === 'string') {
            return key in sessionData ? { [key]: sessionData[key] } : {};
          }
          const out: Record<string, unknown> = {};
          for (const k of key) if (k in sessionData) out[k] = sessionData[k];
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) sessionData[k] = v;
        },
        async remove(keys: string | string[]) {
          const arr = typeof keys === 'string' ? [keys] : keys;
          for (const k of arr) delete sessionData[k];
        },
      },
      onChanged: {
        addListener: (cb: StorageChangeListener) => storageListeners.add(cb),
        removeListener: (cb: StorageChangeListener) => storageListeners.delete(cb),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => ({ ok: true })),
      getManifest: () => manifest,
      onMessage: {
        addListener: (cb: RuntimeMessageListener) => messageListeners.add(cb),
        removeListener: (cb: RuntimeMessageListener) => messageListeners.delete(cb),
      },
      onInstalled: {
        addListener: (cb: RuntimeInstalledListener) => installedListeners.add(cb),
        removeListener: (cb: RuntimeInstalledListener) => installedListeners.delete(cb),
      },
    },
    downloads: {
      download: vi.fn(async () => 1),
      onChanged: {
        addListener: (cb: DownloadChangeListener) => downloadChangeListeners.add(cb),
        removeListener: (cb: DownloadChangeListener) => downloadChangeListeners.delete(cb),
      },
    },
    tabs: {
      query: vi.fn(async () => [] as Array<{ id: number; url: string }>),
      create: vi.fn(async (info: { url: string; active?: boolean }) => ({
        id: 99,
        url: info.url,
        active: info.active ?? false,
      })),
      reload: vi.fn(async (_tabId: number) => undefined),
      remove: vi.fn(async (_tabIds: number | number[]) => undefined),
      get: vi.fn(async (_tabId: number) => {
        // Default: pretend the tab no longer exists. Tests that need a live
        // tab should override this on the returned mock surface.
        throw new Error('No tab with id (mock default)');
      }),
      onRemoved: {
        addListener: (cb: TabsRemovedListener) => tabsRemovedListeners.add(cb),
        removeListener: (cb: TabsRemovedListener) => tabsRemovedListeners.delete(cb),
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).chrome = chromeStub;

  return {
    storage: { local: storageData, listeners: storageListeners },
    runtime: {
      sendMessage: chromeStub.runtime.sendMessage,
      messageListeners,
      installedListeners,
      manifest,
    },
    downloads: {
      download: chromeStub.downloads.download,
      changeListeners: downloadChangeListeners,
    },
    tabs: {
      query: chromeStub.tabs.query,
      create: chromeStub.tabs.create,
      reload: chromeStub.tabs.reload,
      remove: chromeStub.tabs.remove,
      get: chromeStub.tabs.get,
      removedListeners: tabsRemovedListeners,
    },
    storageSession: { data: sessionData },
  };
}

export function uninstallChromeMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).chrome;
}
