import { resolve } from 'path';
import { defineConfig } from 'vite';
import { extDevRpcPlugin } from '@weaver-octopus/ext-dev-rpc/vite';

// `WEAVER_DEV=1 pnpm dev` enables the dev-rpc sidecar:
//   - emits dist/build_id.txt on each rebuild
//   - patches dist/manifest.json with localhost host_permissions
// Production (`pnpm build`) leaves __WEAVER_DEV__ false so the entire
// dev surface is dead-code-eliminated.
const isDev = process.env['WEAVER_DEV'] === '1';

export default defineConfig({
  define: {
    __WEAVER_DEV__: JSON.stringify(isDev),
  },
  plugins: extDevRpcPlugin({ enabled: isDev }),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        intercept: resolve(__dirname, 'src/content/main-world/intercept.ts'),
        myactivity: resolve(__dirname, 'src/myactivity/index.ts'),
        popup: resolve(__dirname, 'popup.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
