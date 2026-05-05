import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Production builds substitute __WEAVER_DEV__ to false; vitest doesn't run
  // through Vite's define machinery the same way, so we pin it explicitly to
  // false here. Tests that need to exercise dev-mode code paths can opt in
  // via vi.stubGlobal in their own files.
  define: {
    __WEAVER_DEV__: 'false',
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
  },
});
