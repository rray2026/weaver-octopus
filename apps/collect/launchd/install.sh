#!/usr/bin/env bash
# Render the launchd plist with absolute paths, install to
# ~/Library/LaunchAgents, and load it. Idempotent — safe to re-run after
# config or path changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ORCHESTRATOR_PATH="$COLLECT_DIR/orchestrator.sh"

# Pull schedule from config.sh
# shellcheck source=../config.sh
source "$COLLECT_DIR/config.sh"

LOG_DIR="${LOG_DIR/#\~/$HOME}"
mkdir -p "$LOG_DIR"

PLIST_TEMPLATE="$SCRIPT_DIR/com.user.weaver-collect.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/com.user.weaver-collect.plist"

# launchd's PATH default is barebones (/usr/bin:/bin:/usr/sbin:/sbin) which
# misses brew (/opt/homebrew/bin) and any node version manager paths. Snap
# the current shell's PATH at install time.
PATH_SNAPSHOT="$PATH"

sed \
  -e "s|__ORCHESTRATOR_PATH__|$ORCHESTRATOR_PATH|g" \
  -e "s|__HOUR__|$LAUNCHD_HOUR|g" \
  -e "s|__MINUTE__|$LAUNCHD_MINUTE|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__PATH__|$PATH_SNAPSHOT|g" \
  "$PLIST_TEMPLATE" > "$PLIST_TARGET"

# Reload (unload-then-load is the idempotent pattern; bootout/bootstrap is
# the modern replacement and accepts re-bootstrap of an already-loaded
# label).
launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET"

echo "Installed: $PLIST_TARGET"
echo "Schedule: $(printf '%02d:%02d' "$LAUNCHD_HOUR" "$LAUNCHD_MINUTE") daily"
echo "Run-immediately for testing:"
echo "  launchctl kickstart -k gui/$(id -u)/com.user.weaver-collect"
echo
echo "Note: the Mac must be awake at the scheduled time for the job to fire."
echo "To wake the Mac before the run (requires sudo):"
echo "  sudo pmset repeat wakeorpoweron MTWRFSU $(printf '%02d' $((LAUNCHD_HOUR - 1))):55:00"
