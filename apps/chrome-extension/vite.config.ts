import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig, type Plugin } from 'vite';

// `WEAVER_DEV=1 pnpm dev` enables an auto-reload loop: every successful
// rebuild emits a fresh dist/build_id.txt, the background service worker
// polls it, and on change reloads the extension + refreshes matched tabs.
// Production builds (`pnpm build`) leave __WEAVER_DEV__ false so the
// related code paths are dead-code-eliminated.
const isDev = process.env['WEAVER_DEV'] === '1';

const buildIdPlugin: Plugin = {
  name: 'weaver-build-id',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'build_id.txt',
      source: String(Date.now()),
    });
  },
};

// In dev we also need to talk to the localhost dev-log-server (cross-origin
// from the extension's perspective — extension origin vs http://localhost).
// MV3 SW fetch requires a matching host_permission, so patch the built
// manifest after Vite copies it from public/. This patch never runs for
// production builds.
const localhostManifestPatch: Plugin = {
  name: 'weaver-dev-manifest-patch',
  apply: 'build',
  closeBundle() {
    const path = resolve(__dirname, 'dist', 'manifest.json');
    let json: { host_permissions?: string[] };
    try {
      json = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return;
    }
    const existing = new Set(json.host_permissions ?? []);
    existing.add('http://127.0.0.1/*');
    existing.add('http://localhost/*');
    json.host_permissions = Array.from(existing);
    writeFileSync(path, JSON.stringify(json, null, 2));
  },
};

export default defineConfig({
  define: {
    __WEAVER_DEV__: JSON.stringify(isDev),
  },
  plugins: isDev ? [buildIdPlugin, localhostManifestPatch] : [],
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
