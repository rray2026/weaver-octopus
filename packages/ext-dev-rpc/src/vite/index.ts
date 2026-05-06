import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface ExtDevRpcPluginOptions {
  /** When false, the plugin is a no-op (so consumers can `enabled: env === 'dev'`). */
  enabled?: boolean;
  /** Output dir relative to the project root. Default `dist`. */
  outDir?: string;
  /** Hosts the dev sidecar may speak to. Patches the built manifest's
   *  host_permissions in dev so the SW can reach the dev-log-server.
   *  Default: ['http://127.0.0.1/*', 'http://localhost/*']. */
  localhostHosts?: string[];
  /** Disable the build_id emission (rare — auto-reload depends on it). */
  emitBuildId?: boolean;
  /** Disable the manifest patch (rare). */
  patchManifest?: boolean;
}

/** Vite plugin that:
 *
 *  1. Emits `dist/build_id.txt` with `Date.now()` on every build. The
 *     extension's auto-reload poller watches this file.
 *  2. After build, mutates `dist/manifest.json` to add localhost host
 *     permissions so the SW can fetch the dev-log-server.
 *
 *  Both side-effects fire only when `enabled: true`. Production builds
 *  pass `enabled: false` (or omit the plugin) to leave manifest +
 *  output untouched.
 */
export function extDevRpcPlugin(options: ExtDevRpcPluginOptions = {}): Plugin[] {
  const enabled = options.enabled ?? false;
  if (!enabled) return [];
  const outDir = options.outDir ?? 'dist';
  const localhostHosts = options.localhostHosts ?? ['http://127.0.0.1/*', 'http://localhost/*'];
  const emitBuildId = options.emitBuildId ?? true;
  const patchManifest = options.patchManifest ?? true;

  const plugins: Plugin[] = [];

  if (emitBuildId) {
    plugins.push({
      name: 'ext-dev-rpc:build-id',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build_id.txt',
          source: String(Date.now()),
        });
      },
    });
  }

  if (patchManifest) {
    plugins.push({
      name: 'ext-dev-rpc:manifest-patch',
      apply: 'build',
      closeBundle() {
        const path = resolve(process.cwd(), outDir, 'manifest.json');
        let json: { host_permissions?: string[] };
        try {
          json = JSON.parse(readFileSync(path, 'utf-8'));
        } catch {
          return;
        }
        const set = new Set<string>(json.host_permissions ?? []);
        for (const h of localhostHosts) set.add(h);
        json.host_permissions = Array.from(set);
        writeFileSync(path, JSON.stringify(json, null, 2));
      },
    });
  }

  return plugins;
}
