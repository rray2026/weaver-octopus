#!/usr/bin/env bash
#
# Periodic cleanup of accumulated state. Safe by default (dry-run); pass
# --apply to actually delete / truncate. Orchestrator invokes this with
# --apply at the end of each successful run, so manual invocation is only
# needed for one-off audits.
#
# Cleans:
#   1. Per-day orchestrator logs in $LOG_DIR older than $LOG_RETENTION_DAYS
#   2. Raw chat dirs in ~/Downloads/weaver-octopus/ older than
#      $RAW_CHATS_RETENTION_DAYS
#   3. apps/chrome-extension/.dev-runtime.log if larger than $DEV_LOG_MAX_MB
#      (truncate, not delete — the SW + server are appending to it)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHROME_EXTENSION_DIR="$REPO_ROOT/apps/chrome-extension"
DEV_RUNTIME_LOG="$CHROME_EXTENSION_DIR/.dev-runtime.log"

# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"
LOG_DIR="${LOG_DIR/#\~/$HOME}"
DOWNLOADS_DIR="$HOME/Downloads/weaver-octopus"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --dry-run) APPLY=false ;;
    -h|--help)
      cat <<EOF
Usage: cleanup.sh [--apply | --dry-run]
  --dry-run   (default) print what would be cleaned, don't touch anything
  --apply     actually delete / truncate

Retention windows are read from config.sh:
  LOG_RETENTION_DAYS=$LOG_RETENTION_DAYS
  RAW_CHATS_RETENTION_DAYS=$RAW_CHATS_RETENTION_DAYS
  DEV_LOG_MAX_MB=$DEV_LOG_MAX_MB
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

echo "$prefix cleanup starting"

# ─── 1. Old per-day orchestrator logs ────────────────────────────────────
if [[ -d "$LOG_DIR" ]]; then
  cutoff_log=$(date -v-"${LOG_RETENTION_DAYS}"d +%s)
  found=0
  while IFS= read -r -d '' f; do
    mtime=$(stat -f %m "$f" 2>/dev/null || echo 0)
    if [[ "$mtime" -lt "$cutoff_log" ]]; then
      found=$((found + 1))
      echo "$prefix log: $f (mtime $(date -r "$mtime" '+%Y-%m-%d'))"
      $APPLY && rm -f "$f"
    fi
  done < <(find "$LOG_DIR" -maxdepth 1 -type f -name "*.log" -print0)
  echo "$prefix logs: $found old file(s) (retention ${LOG_RETENTION_DAYS}d)"
fi

# ─── 2. Old raw chat directories ─────────────────────────────────────────
# Folders are named YYYY-MM-DD; we use the folder name (not mtime) as the
# canonical age, so a re-trigger of an old date doesn't reset its clock.
if [[ -d "$DOWNLOADS_DIR" ]]; then
  cutoff_chat=$(date -v-"${RAW_CHATS_RETENTION_DAYS}"d +%Y-%m-%d)
  found=0
  for d in "$DOWNLOADS_DIR"/*/; do
    [[ -d "$d" ]] || continue
    name=$(basename "$d")
    # Validate it's a YYYY-MM-DD folder; skip anything weird like .DS_Store
    [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    if [[ "$name" < "$cutoff_chat" ]]; then
      found=$((found + 1))
      size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
      echo "$prefix raw chats: $d ($size)"
      $APPLY && rm -rf "$d"
    fi
  done
  echo "$prefix raw chats: $found old dir(s) (retention ${RAW_CHATS_RETENTION_DAYS}d cutoff $cutoff_chat)"
fi

# ─── 3. Truncate the dev-runtime log if oversized ────────────────────────
# Truncate-to-zero is the right move: the SW + log forwarder are appending
# (with O_APPEND); shrinking via truncate doesn't break their fd. Deleting
# the file would, on some platforms.
if [[ -f "$DEV_RUNTIME_LOG" ]]; then
  size_bytes=$(stat -f %z "$DEV_RUNTIME_LOG")
  size_mb=$((size_bytes / 1024 / 1024))
  if [[ "$size_mb" -ge "$DEV_LOG_MAX_MB" ]]; then
    echo "$prefix dev-runtime.log: ${size_mb}MB ≥ ${DEV_LOG_MAX_MB}MB cap → truncate"
    $APPLY && : > "$DEV_RUNTIME_LOG"
  else
    echo "$prefix dev-runtime.log: ${size_mb}MB (cap ${DEV_LOG_MAX_MB}MB) — fine"
  fi
fi

echo "$prefix cleanup done"
