# @weaver-octopus/collect

Daily glue between the chrome-extension's chat backfill and a personal Obsidian-style knowledge base (`world-weaver` by default). Runs unattended at 02:00 via launchd.

```
[02:00 launchd]
   └─ orchestrator.sh
        ├─ pre-flight   (world-weaver clean? today's branch free?)
        ├─ environment  (caffeinate, restart Chrome, RPC server, SW alive)
        ├─ backfill     (filter=yesterday, RPC start-backfill, wait done)
        └─ digest       (3 claude -p calls sharing one --session-id)
                        │
                        └─ Step 3 itself does: branch / commit / push / gh pr create
```

The orchestrator never auto-merges. Each run lands a PR titled `Daily digest YYYY-MM-DD` against `world-weaver` for the user to review.

## Layout

```
apps/collect/
├── config.sh                 # paths + schedule + retention (sourced, no parser)
├── orchestrator.sh           # main entry point
├── cleanup.sh                # periodic state cleanup (logs, raw chats, dev-runtime.log)
├── recover.sh                # diagnose + repair stuck pipeline state
├── lib/
│   ├── chrome.sh             # restart, RPC server, wait helpers
│   ├── claude.sh             # claude -p with shared --session-id
│   └── git.sh                # dirty / branch-collision pre-checks
├── prompts/
│   ├── 01-load-context.md    # read-only context warm-up
│   ├── 02-digest.md          # process raw chats into world-weaver
│   └── 03-publish.md         # branch / commit / push / gh pr create
└── launchd/
    ├── com.user.weaver-collect.plist
    └── install.sh
```

## Prerequisites

| Tool | Why | Check |
|------|-----|-------|
| Claude Code CLI ≥ 2.1 | runs the digest steps | `claude --version` |
| `gh` (GitHub CLI) | opens the daily PR | `gh auth status` |
| `caffeinate` | keeps the Mac awake mid-run | (built-in) |
| `osascript` | restarts Chrome | (built-in) |
| `uuidgen` | generates the claude session id | (built-in) |
| Chrome with the extension's `build:rpc` bundle loaded | RPC ↔ SW handshake | see below |

### One-time chrome-extension setup

```bash
pnpm install
pnpm --filter @weaver-octopus/chrome-extension build:rpc
```

Then in Chrome: `chrome://extensions` → enable Developer Mode → **Load unpacked** → select `apps/chrome-extension/dist/`. After any future rebuild, click ↺ on the card.

The `build:rpc` bundle adds `http://127.0.0.1/*` to the manifest so the SW can reach the RPC server the orchestrator spawns.

## Configuration

Two files:

- **`config.sh`** (committed) — defaults that work for any user. Don't put personal paths here.
- **`config.local.sh`** (gitignored) — your private overrides. Sourced last so it can override anything.

`WORLD_WEAVER_PATH` has no default and **must** be set in `config.local.sh`. Minimum first-run setup:

```bash
cat > apps/collect/config.local.sh <<'EOF'
WORLD_WEAVER_PATH="$HOME/path/to/world-weaver"
EOF
```

Other defaults (override in `config.local.sh` if you want different):

- providers: `(claude gemini chatgpt)`
- date filter: `yesterday`
- log dir: `~/Library/Logs/weaver-collect/`
- schedule: 02:00 daily
- branch template: `auto/digest-{DATE}` (forked from `main`)
- retention: 30-day logs / 30-day raw chats / 10 MB dev-runtime.log cap

## Running

### Manually (any time)

```bash
./apps/collect/orchestrator.sh
```

It logs to `~/Library/Logs/weaver-collect/<today>.log` AND stdout. Tail the log:

```bash
tail -F ~/Library/Logs/weaver-collect/$(date +%Y-%m-%d).log
```

### Install daily schedule

```bash
./apps/collect/launchd/install.sh
```

Idempotent. Re-run after edits to `config.sh`.

### Force run now (uses launchd's environment)

```bash
launchctl kickstart -k gui/$(id -u)/com.user.weaver-collect
```

### Uninstall

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.user.weaver-collect.plist
rm ~/Library/LaunchAgents/com.user.weaver-collect.plist
```

## Maintenance

### Cleanup (`cleanup.sh`)

Periodic cleanup of accumulated state. The orchestrator runs this with `--apply` at the end of every successful run, so manual invocation is rarely needed.

```bash
./apps/collect/cleanup.sh             # dry-run by default
./apps/collect/cleanup.sh --apply     # actually delete / truncate
```

What it touches (retention windows in `config.sh`):

| Target | Default | Action |
|--------|---------|--------|
| `~/Library/Logs/weaver-collect/*.log` | older than 30 days | delete |
| `~/Downloads/weaver-octopus/<YYYY-MM-DD>/` | folder name older than 30 days | `rm -rf` |
| `apps/chrome-extension/.dev-runtime.log` | size > 10 MB | truncate (not delete — the SW is appending) |

### Recover (`recover.sh`)

Diagnose-and-fix for stuck pipeline state. Safe by default — dry-run reports findings, you decide whether to act.

```bash
./apps/collect/recover.sh             # diagnose only
./apps/collect/recover.sh --apply     # kill stale procs, send stop-backfill
```

What it checks:

1. **Orphan `caffeinate -dis` processes** whose orchestrator parent died. `--apply` kills them.
2. **Multiple `ext-dev-rpc-server` instances**. Only the lowest-PID one binds 9876; `--apply` kills the rest.
3. **Stuck extension state** — sends `stop-backfill` so `backfillProgress.state` is no longer `"running"`. `--apply` actually sends.
4. **world-weaver state** — branch + dirty status reported, never auto-fixed (it might contain your manual work). The output shows the exact `git stash` / `git checkout` commands you'd run.

## Pre-flight semantics (why a run might decline to start)

- **world-weaver dirty** → exit 1, no changes. The user has uncommitted work; we won't touch it.
- **today's branch already exists locally or on origin** → exit 1, no changes. Assumes the run already happened today (manual or a duplicate launchd fire).
- **RAW_DIR empty after backfill** → exit 0. No new chats yesterday → nothing to digest. Not an error.
- **Backfill timeout** (default 10 min) → exit 1, no digest. Chrome was likely throttled despite the restart; investigate the dev runtime log.

## Known caveats

- **Mac must be awake at 02:00.** launchd alone won't wake it. To enable:
  ```bash
  sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
  ```
- **Chrome restart is intrusive if you're using Chrome at 02:00.** It's a graceful quit (session restored on relaunch), but any in-progress upload / unsaved form will be lost.
- **Cross-device.** The launchd label installs per-user on this Mac. To run on another machine, just copy the repo and re-run `install.sh`.
