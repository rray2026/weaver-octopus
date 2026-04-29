import { defineConfig } from '@playwright/test';

// Keep e2e isolated from the vitest unit suite. `pnpm test:e2e` runs only
// these specs; `pnpm test` (vitest) ignores test/e2e/.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.e2e\.test\.ts$/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    actionTimeout: 10_000,
  },
});
