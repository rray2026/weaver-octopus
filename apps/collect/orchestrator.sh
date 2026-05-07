#!/usr/bin/env bash
#
# Daily collect pipeline. Triggered by launchd at 02:00 (or manually).
#
# 5 stages:
#   1. Pre-flight  — config, dirty check, branch existence check
#   2. Environment — caffeinate, Chrome restart, RPC server, SW alive
#   3. Backfill    — set-filter yesterday, start-backfill, wait done
#   4. Digest      — 3 Claude invocations sharing one session
#   5. Done        — orchestrator exits; the digest's step-3 prompt has
#                    already pushed and opened the PR.

set -euo pipefail

# ─── Resolve own location ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHROME_EXTENSION_DIR="$REPO_ROOT/apps/chrome-extension"
RPC_LOG_PATH="$CHROME_EXTENSION_DIR/.dev-runtime.log"

# ─── Load config ─────────────────────────────────────────────────────────
# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"

if [[ -z "${WORLD_WEAVER_PATH:-}" ]]; then
  echo "Error: WORLD_WEAVER_PATH is unset." >&2
  echo "Create $SCRIPT_DIR/config.local.sh with at minimum:" >&2
  echo "  WORLD_WEAVER_PATH=\"\$HOME/path/to/world-weaver\"" >&2
  exit 1
fi

# Resolve world-weaver path to absolute. Allow tilde + relative.
WORLD_WEAVER_PATH="$(cd "$SCRIPT_DIR" && cd "${WORLD_WEAVER_PATH/#\~/$HOME}" && pwd)"

# Date being digested = "yesterday" in local TZ. The world-weaver schema is
# UTC+8, but launchd runs in local TZ (which we assume is UTC+8 for this
# user). If you move time zones, set TZ explicitly here.
DIGEST_DATE=$(date -v-1d +%Y-%m-%d)
RAW_DIR="$HOME/Downloads/weaver-octopus/$DIGEST_DATE"
BRANCH="${BRANCH_TEMPLATE/\{DATE\}/$DIGEST_DATE}"

# ─── Logging ─────────────────────────────────────────────────────────────
mkdir -p "${LOG_DIR/#\~/$HOME}"
LOG_FILE="${LOG_DIR/#\~/$HOME}/$(date +%Y-%m-%d).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "═══════════════════════════════════════════════════════════════════"
echo "weaver-collect run started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  digest date:      $DIGEST_DATE"
echo "  raw chats dir:    $RAW_DIR"
echo "  world-weaver:     $WORLD_WEAVER_PATH"
echo "  target branch:    $BRANCH"
echo "═══════════════════════════════════════════════════════════════════"

# ─── Source libs ─────────────────────────────────────────────────────────
# shellcheck source=./lib/git.sh
source "$SCRIPT_DIR/lib/git.sh"
# shellcheck source=./lib/chrome.sh
source "$SCRIPT_DIR/lib/chrome.sh"
# shellcheck source=./lib/claude.sh
source "$SCRIPT_DIR/lib/claude.sh"

# ─── Cleanup trap ────────────────────────────────────────────────────────
CAFFEINATE_PID=""
RPC_SERVER_PID=""
cleanup() {
  local exit_code=$?
  echo "─── cleanup (exit=$exit_code) ───"
  [[ -n "$CAFFEINATE_PID" ]] && kill "$CAFFEINATE_PID" 2>/dev/null || true
  rpc_stop_if_owned
  echo "weaver-collect run finished: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ─── 1. Pre-flight ───────────────────────────────────────────────────────
echo "─── 1. Pre-flight ───"
git_assert_clean "$WORLD_WEAVER_PATH"
git_assert_branch_unused "$WORLD_WEAVER_PATH" "$BRANCH"

# Step 3 of the previous run left the tree on an auto/digest-* branch.
# Reset to the default branch BEFORE digesting so the new branch forks
# from a clean main, not from yesterday's PR branch.
current_branch=$(git -C "$WORLD_WEAVER_PATH" branch --show-current)
if [[ "$current_branch" != "$WORLD_WEAVER_DEFAULT_BRANCH" ]]; then
  echo "[git] checkout $WORLD_WEAVER_DEFAULT_BRANCH (was on $current_branch)"
  git -C "$WORLD_WEAVER_PATH" checkout "$WORLD_WEAVER_DEFAULT_BRANCH"
fi

# ─── 2. Environment ──────────────────────────────────────────────────────
echo "─── 2. Environment ───"

if [[ "$CAFFEINATE_DURING_RUN" == "true" ]]; then
  caffeinate -dis &
  CAFFEINATE_PID=$!
  echo "[env] caffeinate started (pid $CAFFEINATE_PID)"
fi

if [[ "$CHROME_RESTART_BEFORE_RUN" == "true" ]]; then
  chrome_restart
  echo "[env] waiting ${CHROME_WAIT_SECONDS}s for Chrome to settle..."
  sleep "$CHROME_WAIT_SECONDS"
fi

rpc_ensure_server
chrome_wait_sw_alive 30

# ─── 3. Backfill ─────────────────────────────────────────────────────────
echo "─── 3. Backfill ───"

# Always issue a stop-backfill first to clear any stale "running" state
# left by a previous crash / Chrome quit mid-flight. Cheap when nothing is
# running, lifesaving when something stale is.
rpc_command '{"action":"stop-backfill"}' >/dev/null
sleep 2
echo "[backfill] cleared stale state"

rpc_command "{\"action\":\"set-filter\",\"type\":\"$DATE_FILTER\"}" >/dev/null
echo "[backfill] filter set to $DATE_FILTER"

# JSON-array of providers from the bash array
PROVIDERS_JSON=$(printf '"%s",' "${PROVIDERS[@]}" | sed 's/,$//')
rpc_command "{\"action\":\"start-backfill\",\"providers\":[$PROVIDERS_JSON]}" >/dev/null
echo "[backfill] start signal sent for providers: ${PROVIDERS[*]}"

if ! chrome_wait_backfill_done "$BACKFILL_TIMEOUT_MINUTES"; then
  echo "[backfill] timed out — aborting before digest"
  exit 1
fi

# ─── 4. Digest ───────────────────────────────────────────────────────────
echo "─── 4. Digest ───"

if [[ ! -d "$RAW_DIR" ]] || [[ -z "$(ls -A "$RAW_DIR" 2>/dev/null)" ]]; then
  echo "[digest] no raw chats at $RAW_DIR — nothing to digest, exiting cleanly"
  exit 0
fi

CHAT_COUNT=$(ls "$RAW_DIR" | wc -l | xargs)
echo "[digest] $CHAT_COUNT raw chat file(s) in $RAW_DIR"

CLAUDE_SESSION_ID=$(claude_new_session_id)
echo "[digest] claude session id: $CLAUDE_SESSION_ID"

# Variables exposed to prompts via envsubst.
export RAW_DIR DIGEST_DATE BRANCH WORLD_WEAVER_PATH CHAT_COUNT CLAUDE_SESSION_ID

echo "── Step 1/3: load context ──"
claude_run "$SCRIPT_DIR/prompts/01-load-context.md" first

echo "── Step 2/3: digest ──"
claude_run "$SCRIPT_DIR/prompts/02-digest.md" resume

echo "── Step 3/3: publish ──"
claude_run "$SCRIPT_DIR/prompts/03-publish.md" resume

# ─── 5. Cleanup ──────────────────────────────────────────────────────────
# Soft step: failures here don't fail the run. Daily cleanup keeps logs +
# raw chats from growing unbounded over time.
echo "─── 5. Cleanup ───"
"$SCRIPT_DIR/cleanup.sh" --apply || echo "[cleanup] non-fatal failure (continuing)"

echo "─── Done ───"
