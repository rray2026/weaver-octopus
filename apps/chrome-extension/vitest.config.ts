import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Production builds substitute __WEAVER_DEV__ / __WEAVER_RPC__ to false;
  // vitest doesn't run through Vite's define machinery the same way, so we
  // pin both flags explicitly here. Tests that need to exercise dev / rpc
  // code paths can opt in via vi.stubGlobal in their own files.
  define: {
    __WEAVER_DEV__: 'false',
    __WEAVER_RPC__: 'false',
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
  },
});
