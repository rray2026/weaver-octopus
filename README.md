# weaver-octopus

Node.js monorepo built with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build).

## Structure

```
weaver-octopus/
├── apps/
│   ├── api/          # Express REST API (port 3000)
│   └── web/          # Web server (port 3001)
├── packages/
│   ├── tsconfig/     # Shared TypeScript configurations
│   ├── eslint-config/ # Shared ESLint configurations
│   └── utils/        # Shared utilities (logger, result type, env helpers)
├── turbo.json
└── pnpm-workspace.yaml
```

## Prerequisites

- Node.js >= 20
- pnpm >= 9

## Getting started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all apps in dev mode
pnpm dev

# Run tests
pnpm test

# Lint
pnpm lint

# Format
pnpm format
```

## Apps

| App | Port | Description |
|-----|------|-------------|
| `@weaver-octopus/api` | 3000 | Express REST API |
| `@weaver-octopus/web` | 3001 | Web server |
| `@weaver-octopus/chrome-extension` | — | Chrome extension — captures Claude chats as Markdown |

See [`apps/chrome-extension/DEVELOPMENT.md`](apps/chrome-extension/DEVELOPMENT.md) for the extension's architecture, DOM selectors, and debugging guide.

## Packages

| Package | Description |
|---------|-------------|
| `@weaver-octopus/utils` | Shared utilities: structured logger, Result type, env helpers |
| `@weaver-octopus/tsconfig` | Shared TypeScript configs |
| `@weaver-octopus/eslint-config` | Shared ESLint configs |

## Environment variables

Copy `.env.example` to `.env` in each app directory and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 (api) / 3001 (web) | Server port |
| `API_URL` | `http://localhost:3000` | API base URL (web only) |
