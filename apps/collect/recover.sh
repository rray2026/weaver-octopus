#!/usr/bin/env bash
#
# Diagnose and recover from a stuck pipeline state. Safe by default
# (diagnose only); pass --apply to act on findings.
#
# Common stuck states this script handles:
#   1. Orphan `caffeinate` from a crashed orchestrator run
#   2. Orphan ext-dev-rpc-server processes
#   3. backfillProgress.state="running" left over from a Chrome quit
#      mid-flight (the next orchestrator run already self-heals via
#      stop-before-start, but useful to clear by hand for ad-hoc curl use)
#   4. world-weaver in a dirty / wrong-branch state from a failed Step 2
#
# What this script does NOT do automatically:
#   - Touch the world-weaver working tree (it might contain manual work)
#   - Delete branches (you may want to inspect them first)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"

if [[ -z "${WORLD_WEAVER_PATH:-}" ]]; then
  echo "Error: WORLD_WEAVER_PATH is unset (create $SCRIPT_DIR/config.local.sh)." >&2
  exit 1
fi

WORLD_WEAVER_PATH="$(cd "$SCRIPT_DIR" && cd "${WORLD_WEAVER_PATH/#\~/$HOME}" && pwd)"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --dry-run) APPLY=false ;;
    -h|--help)
      cat <<EOF
Usage: recover.sh [--apply | --dry-run]
  --dry-run   (default) report stuck state, suggest fixes, don't act
  --apply     kill stale processes, clear stale extension state

The world-weaver working tree is never modified by this script — its
state is reported but you decide whether to git stash / git checkout.
EOF
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

if $APPLY; then
  prefix="[apply]"
else
  prefix="[dry-run]"
fi

echo "$prefix recover starting"

issues=0

# ─── 1. Orphan caffeinate processes ──────────────────────────────────────
# The orchestrator launches `caffeinate -dis &` and traps EXIT to kill it.
# If the orchestrator was hard-killed (Activity Monitor, kill -9), the
# child can outlive its parent and stick around as long as it likes.
echo "── 1. caffeinate orphans ──"
caf_pids=$(pgrep -fl 'caffeinate -dis' | awk '{print $1}' || true)
if [[ -n "$caf_pids" ]]; then
  while IFS= read -r pid; do
    started=$(ps -p "$pid" -o lstart= 2>/dev/null || echo unknown)
    parent=$(ps -p "$pid" -o ppid= 2>/dev/null | xargs)
    parent_alive=true
    [[ "$parent" == "1" || "$parent" == "0" ]] && parent_alive=false
    echo "$prefix caffeinate pid=$pid started='$started' ppid=$parent (orphan: $([[ "$parent_alive" == "false" ]] && echo yes || echo no))"
    if [[ "$parent_alive" == "false" ]]; then
      issues=$((issues + 1))
      $APPLY && kill "$pid" && echo "$prefix   killed"
    fi
  done <<< "$caf_pids"
else
  echo "$prefix none"
fi

# ─── 2. Orphan ext-dev-rpc-server processes ──────────────────────────────
# Each orchestrator run starts one if not present. Multiple instances
# wouldn't bind 9876 (only the first wins), but they'd waste CPU on the
# log forwarder. Show all and let the user decide.
echo "── 2. ext-dev-rpc-server processes ──"
rpc_pids=$(pgrep -fl 'ext-dev-rpc-server' | awk '{print $1}' || true)
if [[ -n "$rpc_pids" ]]; then
  while IFS= read -r pid; do
    started=$(ps -p "$pid" -o lstart= 2>/dev/null || echo unknown)
    parent=$(ps -p "$pid" -o ppid= 2>/dev/null | xargs)
    echo "$prefix ext-dev-rpc-server pid=$pid started='$started' ppid=$parent"
  done <<< "$rpc_pids"
  count=$(echo "$rpc_pids" | wc -l | xargs)
  if [[ "$count" -gt 1 ]]; then
    issues=$((issues + 1))
    echo "$prefix   $count instances — multiple servers; only one binds 9876."
    if $APPLY; then
      # Kill all but the lowest-PID (assumed to be the original).
      keep=$(echo "$rpc_pids" | sort -n | head -1)
      while IFS= read -r pid; do
        [[ "$pid" == "$keep" ]] && continue
        kill "$pid" && echo "$prefix   killed pid=$pid (kept $keep)"
      done <<< "$rpc_pids"
    fi
  fi
else
  echo "$prefix none"
fi

# ─── 3. Stuck backfillProgress.state ─────────────────────────────────────
# Sends a stop-backfill via curl; SW transitions running→stopping. The
# next start-backfill will overwrite that without complaint.
echo "── 3. extension backfillProgress.state ──"
if curl -sf "$RPC_BASE/status" >/dev/null 2>&1; then
  if $APPLY; then
    curl -sf -X POST "$RPC_BASE/command" \
      -H 'Content-Type: application/json' \
      -d '{"action":"stop-backfill"}' >/dev/null
    echo "$prefix sent stop-backfill (next start-backfill is now safe)"
  else
    echo "$prefix would send stop-backfill"
  fi
else
  echo "$prefix RPC not reachable at $RPC_BASE — skipping (the SW may be asleep or extension not loaded)"
fi

# ─── 4. world-weaver state — REPORT ONLY ─────────────────────────────────
# We never auto-modify world-weaver. The pre-flight check in orchestrator.sh
# already protects against running on dirty state; this is for the user.
echo "── 4. world-weaver state (report only) ──"
if [[ -d "$WORLD_WEAVER_PATH/.git" ]]; then
  branch=$(git -C "$WORLD_WEAVER_PATH" branch --show-current)
  dirty=$(git -C "$WORLD_WEAVER_PATH" status --porcelain | wc -l | xargs)
  echo "$prefix branch: $branch"
  echo "$prefix dirty files: $dirty"
  if [[ "$dirty" -gt 0 ]]; then
    issues=$((issues + 1))
    echo "$prefix   working tree has uncommitted changes — orchestrator will refuse to run"
    echo "$prefix   resolve manually:"
    echo "$prefix     cd $WORLD_WEAVER_PATH"
    echo "$prefix     git status                       # see what's there"
    echo "$prefix     git stash push -m 'recover-N'    # if salvageable"
    echo "$prefix     git checkout .                   # if disposable (DESTRUCTIVE)"
  fi
  # Stale auto/digest-* branches that aren't currently checked out.
  stale=$(git -C "$WORLD_WEAVER_PATH" branch --list 'auto/digest-*' \
    | grep -v '^\*' | sed 's/^[ *]*//' || true)
  if [[ -n "$stale" ]]; then
    echo "$prefix local auto/digest-* branches:"
    echo "$stale" | sed "s/^/$prefix   /"
    echo "$prefix   delete merged ones with: git -C $WORLD_WEAVER_PATH branch -d <name>"
  fi
fi

echo "── summary ──"
echo "$prefix $issues actionable issue(s) found"
$APPLY || echo "$prefix run with --apply to act on them"
echo "$prefix recover done"
