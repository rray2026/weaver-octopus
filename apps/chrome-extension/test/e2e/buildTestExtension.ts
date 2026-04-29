// Copies the production build to a tmp dir and rewrites manifest.json so the
// extension activates on http://127.0.0.1:* in addition to claude.ai. Used
// only by the playwright e2e test — production builds are untouched.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Resolved relative to the package root — Playwright spawns from there.
const DIST = resolve(process.cwd(), 'dist');

export function buildTestExtension(): string {
  if (!existsSync(DIST)) {
    throw new Error(`dist/ not found at ${DIST} — run \`pnpm build\` first.`);
  }
  const outDir = mkdtempSync(join(tmpdir(), 'weaver-ext-'));
  cpSync(DIST, outDir, { recursive: true });

  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const localhostMatch = 'http://127.0.0.1:*/*';

  for (const entry of manifest.content_scripts ?? []) {
    if (Array.isArray(entry.matches) && !entry.matches.includes(localhostMatch)) {
      entry.matches.push(localhostMatch);
    }
  }
  if (Array.isArray(manifest.host_permissions) && !manifest.host_permissions.includes(localhostMatch)) {
    manifest.host_permissions.push(localhostMatch);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return outDir;
}
