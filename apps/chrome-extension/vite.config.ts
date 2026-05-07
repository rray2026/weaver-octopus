import { resolve } from 'path';
import { defineConfig } from 'vite';
import { extDevRpcPlugin } from '@weaver-octopus/ext-dev-rpc/vite';

// `WEAVER_DEV=1 pnpm dev` enables the full dev-rpc sidecar:
//   - emits dist/build_id.txt on each rebuild
//   - patches dist/manifest.json with localhost host_permissions
//   - auto-reload, log forwarding, command poller
// `WEAVER_RPC=1 pnpm build:rpc` enables the production command-poller only:
//   - patches dist/manifest.json with localhost host_permissions
//   - command poller (no auto-reload, no log forwarding)
// Plain `pnpm build` leaves both flags false — entire RPC surface is
// dead-code-eliminated by Rollup.
const isDev = process.env['WEAVER_DEV'] === '1';
const isRpc = process.env['WEAVER_RPC'] === '1';

export default defineConfig({
  define: {
    __WEAVER_DEV__: JSON.stringify(isDev),
    __WEAVER_RPC__: JSON.stringify(isRpc),
  },
  plugins: extDevRpcPlugin({ enabled: isDev || isRpc, emitBuildId: isDev }),
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
        'intercept-chatgpt': resolve(
          __dirname,
          'src/content/main-world/intercept-chatgpt.ts',
        ),
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
