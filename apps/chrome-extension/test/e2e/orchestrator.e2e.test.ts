// L3: real Chromium + real extension + real cross-world postMessage.
// L1/L2 (vitest, jsdom) can't catch bugs that live at the MV3-world boundary
// — e.g. event.source !== window failing because the MAIN-world and
// ISOLATED-world `window` proxies aren't === equal. This file exercises the
// full pipeline: page fetch → intercept (MAIN) → orchestrator (ISOLATED) →
// background → chrome.storage.local.
//
// Cases covered:
//  1. Happy path: a conversation fetch produces a download.
//  2. Same conversation fetched twice in same tab → 1 download (in-mem dedup).
//  3. Two different conversations → 2 downloads (per-conv state).
//  4. Reset (clearing convHashes) does NOT auto-download.
//  5. Reset followed by a fresh fetch DOES download again.
//  6. Non-conversation /api/ URL is ignored (intercept regex correctness).
//  7. Tab reload with same body → no re-download (storage hydration works).
import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTestExtension } from './buildTestExtension.js';
import {
  CONV_UUID,
  CONV_UUID_B,
  conversationUrl,
  startServer,
  type E2EServer,
} from './server.js';

let server: E2EServer;
let extPath: string;
let userDataDir: string;
let context: BrowserContext;

test.beforeAll(async () => {
  server = await startServer();
  extPath = buildTestExtension();
  userDataDir = mkdtempSync(join(tmpdir(), 'weaver-ext-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
});

test.beforeEach(async () => {
  // Reset extension state between cases. We share one context across the
  // suite (faster than launching per-test) and clear the bits each case
  // depends on at the start.
  const worker = await getServiceWorker(context);
  await worker.evaluate(() => chrome.storage.local.clear());
  for (const p of context.pages()) await p.close();
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  if (extPath) rmSync(extPath, { recursive: true, force: true });
});

async function getServiceWorker(ctx: BrowserContext): Promise<Worker> {
  const existing = ctx.serviceWorkers();
  if (existing.length > 0) return existing[0]!;
  return ctx.waitForEvent('serviceworker');
}

interface DownloadRecord {
  filename: string;
  at: number;
}

async function readLastDownload(worker: Worker): Promise<DownloadRecord | null> {
  return worker.evaluate(async () => {
    const r = (await chrome.storage.local.get('lastDownload')) as {
      lastDownload?: { filename: string; at: number };
    };
    return r.lastDownload ?? null;
  });
}

async function readConvHashes(worker: Worker): Promise<Record<string, string>> {
  return worker.evaluate(async () => {
    const r = (await chrome.storage.local.get('convHashes')) as {
      convHashes?: Record<string, string>;
    };
    return r.convHashes ?? {};
  });
}

async function newPage(): Promise<import('@playwright/test').Page> {
  const page = await context.newPage();
  await page.goto(`${server.url}/`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function fetchOnPage(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.evaluate(
    async (u) => (window as unknown as { weaverFetch: (u: string) => Promise<unknown> }).weaverFetch(u),
    url,
  );
}

async function expectLastDownload(worker: Worker, matcher: RegExp): Promise<DownloadRecord> {
  await expect
    .poll(() => readLastDownload(worker), {
      timeout: 10_000,
      intervals: [200, 400, 800],
    })
    .not.toBeNull();
  const last = (await readLastDownload(worker))!;
  expect(last.filename).toMatch(matcher);
  return last;
}

test('1. happy path — conversation fetch produces a download', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();
  await fetchOnPage(page, conversationUrl(CONV_UUID));

  const last = await expectLastDownload(worker, /\[claude\] E2E Sample-22222222\.md$/);
  expect(last.filename).toContain('weaver-octopus/');
  expect(last.at).toBeGreaterThan(0);
});

test('2. same conversation fetched twice → only one download (in-memory dedup)', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expectLastDownload(worker, /E2E Sample-22222222/);
  const firstAt = (await readLastDownload(worker))!.at;

  // Same content again — orchestrator hashes it, sees the hash matches, skips.
  await fetchOnPage(page, conversationUrl(CONV_UUID));
  // Give the chain time to run if it's going to.
  await page.waitForTimeout(500);
  const secondAt = (await readLastDownload(worker))!.at;
  expect(secondAt).toBe(firstAt);
});

test('3. two different conversations → two downloads', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expectLastDownload(worker, /E2E Sample-22222222/);

  await fetchOnPage(page, conversationUrl(CONV_UUID_B));
  await expectLastDownload(worker, /E2E Sample B-33333333/);

  const hashes = await readConvHashes(worker);
  expect(Object.keys(hashes).sort()).toEqual([CONV_UUID, CONV_UUID_B].sort());
});

test('4. reset (clear convHashes) does NOT auto-download', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expectLastDownload(worker, /E2E Sample-22222222/);
  const beforeReset = (await readLastDownload(worker))!.at;

  await worker.evaluate(() => chrome.storage.local.remove('convHashes'));

  // Wait long enough that any reprocess would have happened.
  await page.waitForTimeout(800);
  const afterReset = (await readLastDownload(worker))!.at;
  expect(afterReset).toBe(beforeReset);
  expect(await readConvHashes(worker)).toEqual({});
});

test('5. reset followed by a fresh fetch DOES download again', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expectLastDownload(worker, /E2E Sample-22222222/);
  const before = (await readLastDownload(worker))!.at;

  await worker.evaluate(() => chrome.storage.local.remove('convHashes'));

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expect
    .poll(async () => (await readLastDownload(worker))?.at ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(before);
});

test('6. non-conversation /api/ URL is ignored', async () => {
  const worker = await getServiceWorker(context);
  const page = await newPage();

  await fetchOnPage(page, '/api/something_else');

  await page.waitForTimeout(800);
  expect(await readLastDownload(worker)).toBeNull();
  expect(await readConvHashes(worker)).toEqual({});
});

test('7. tab reload with same body → no re-download (storage hydration)', async () => {
  const worker = await getServiceWorker(context);
  let page = await newPage();

  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await expectLastDownload(worker, /E2E Sample-22222222/);
  const before = (await readLastDownload(worker))!.at;

  // Full reload — content scripts re-attach, orchestrator hydrates from storage.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await fetchOnPage(page, conversationUrl(CONV_UUID));
  await page.waitForTimeout(800);
  const after = (await readLastDownload(worker))!.at;
  expect(after).toBe(before);
  void page;
});

