# weaver-octopus

pnpm monorepo — Node.js apps + Chrome extension.

## Repository layout

```
apps/
  api/               Express REST API (port 3000)
  web/               Web server (port 3001)
  chrome-extension/  Manifest V3 Chrome extension — captures Claude chats as Markdown
packages/
  tsconfig/          Shared TypeScript configs
  eslint-config/     Shared ESLint flat configs
  utils/             Shared utilities: logger, Result<T,E>, env helpers
```

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

The extension only activates on `claude.ai`. It automatically downloads today's chat turns as `~/Downloads/weaver-octopus/YYYY-MM-DD/<title>.md` after each AI response completes.

See `apps/chrome-extension/DEVELOPMENT.md` for full architecture and debugging guide.

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
