# weaver-octopus

pnpm monorepo — Node.js apps + Chrome extension.

## Repository layout

```
apps/
  api/               Express REST API (port 3000)
  web/               Web server (port 3001)
  chrome-extension/  Manifest V3 Chrome extension — captures Claude chats as Markdown
  collect/           Daily glue (shell + launchd) — drives chrome-extension's
                     RPC, then runs Claude Code over the freshly downloaded
                     chats to maintain a personal Obsidian-style knowledge base
packages/
  tsconfig/          Shared TypeScript configs
  eslint-config/     Shared ESLint flat configs
  utils/             Shared utilities: logger, Result<T,E>, env helpers
  ext-dev-rpc/       Sidecar RPC for driving the running chrome extension from
                     the terminal — log forwarding, command queue, hot reload
```

`apps/collect/` is shell-only (no `package.json`) and is therefore ignored
by the pnpm workspace; it lives next to `apps/chrome-extension/` because
its job is to orchestrate that extension end-to-end.

## Common commands

All commands run from the repo root unless noted.

```bash
pnpm install          # install all workspace dependencies
pnpm build            # build every package (Turborepo, respects dependency order)
pnpm test             # run all test suites
pnpm dev              # start all apps in watch/dev mode (parallel)
pnpm lint             # lint all packages
pnpm format           # prettier write
pnpm type-check       # tsc --noEmit across all packages
```

Single-package commands:

```bash
pnpm --filter @weaver-octopus/chrome-extension build
pnpm --filter @weaver-octopus/api dev
pnpm --filter @weaver-octopus/utils test
```

## Chrome extension — quick reference

Build output: `apps/chrome-extension/dist/`

Load in Chrome:
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `apps/chrome-extension/dist/`
3. After any rebuild, click the **↺ refresh** button on the extension card

The extension activates on `claude.ai`, `gemini.google.com` and `chatgpt.com`.
Backfill-only: passive browsing writes nothing — the user (or the `collect`
runner) clicks 「批量回填」 / fires `start-backfill` to drive a sidebar walk
that downloads in-range chats as `~/Downloads/weaver-octopus/YYYY-MM-DD/<title>.md`.

Three build variants:
- `pnpm --filter @weaver-octopus/chrome-extension build` — production, no RPC
- `pnpm --filter @weaver-octopus/chrome-extension build:rpc` — production + curl RPC
- `pnpm --filter @weaver-octopus/chrome-extension build:dev` — dev sidecar (auto-reload, log forwarding)

See `apps/chrome-extension/DEVELOPMENT.md` for the full architecture, debugging
guide, and curl RPC reference.

## Collect (daily knowledge-base updater)

`apps/collect/` is a shell pipeline triggered by launchd at 02:00 daily:

1. Quit + relaunch Chrome (clears macOS App Nap / per-tab throttle state)
2. Drive the extension's RPC to backfill yesterday's chats from all 3 providers
3. Run a Claude Code session (3 prompts sharing one `--session-id`) that
   reads the raw chats and updates an Obsidian-style knowledge base at a
   configured path
4. Branch / commit / push / open a PR for human review

Setup:
```bash
./apps/collect/launchd/install.sh   # idempotent — re-run after config edits
```

Manual run:
```bash
./apps/collect/orchestrator.sh
```

Per-day logs land in `~/Library/Logs/weaver-collect/`. See `apps/collect/README.md`
for prerequisites (claude CLI, gh, the `build:rpc` extension bundle) and configuration.

## Shared packages

`@weaver-octopus/utils` exports:
- `logger` — structured JSON logger (Node.js only, uses `process.stdout`; **not safe in browser context**)
- `ok / err / isOk / isErr / unwrap` — `Result<T, E>` type helpers (safe everywhere)
- `requireEnv / optionalEnv` — env var helpers (Node.js only)

## TypeScript

All packages use strict TypeScript (ES2022 target). The chrome extension uses `"moduleResolution": "Bundler"` and DOM libs; other packages use Node16 resolution.

## Testing

Test runner: Vitest. Tests live alongside source files as `*.test.ts`.

```bash
pnpm test                            # all packages
pnpm --filter @weaver-octopus/utils test --reporter=verbose
```

## Environment variables

Each app has a `.env.example`. Copy to `.env` and adjust:

| App | Variable | Default |
|-----|----------|---------|
| api | `PORT` | `3000` |
| web | `PORT` | `3001` |
| web | `API_URL` | `http://localhost:3000` |
