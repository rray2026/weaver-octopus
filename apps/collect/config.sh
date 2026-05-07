# Public defaults for the daily collect pipeline. Sourced by orchestrator.sh
# / cleanup.sh / recover.sh / launchd/install.sh.
#
# Anything host-specific (the world-weaver path, schedule preferences, etc.)
# goes in `config.local.sh` — gitignored, sourced at the end of this file.
# A first-time setup needs at minimum:
#
#   $ cat > apps/collect/config.local.sh <<EOF
#   WORLD_WEAVER_PATH="\$HOME/path/to/world-weaver"
#   EOF
#
# See apps/collect/README.md for the full list of overridable values.

# ─── Required (no sane default — must be set in config.local.sh) ─────────
WORLD_WEAVER_PATH=""

# ─── World-weaver behaviour ──────────────────────────────────────────────
# The branch each daily auto/digest-* PR is forked from. Step 3 leaves the
# tree on the new branch, so the orchestrator checks this out at the start
# of every run.
WORLD_WEAVER_DEFAULT_BRANCH="main"

# ─── Providers + date filter ─────────────────────────────────────────────
PROVIDERS=(claude gemini chatgpt)
DATE_FILTER="yesterday"

# ─── Chrome / OS / RPC ───────────────────────────────────────────────────
CHROME_RESTART_BEFORE_RUN=true
CHROME_WAIT_SECONDS=15
CAFFEINATE_DURING_RUN=true
BACKFILL_TIMEOUT_MINUTES=10
RPC_BASE="http://127.0.0.1:9876"

# ─── Logging / branching ─────────────────────────────────────────────────
LOG_DIR="$HOME/Library/Logs/weaver-collect"
BRANCH_TEMPLATE="auto/digest-{DATE}"

# ─── launchd schedule (used by launchd/install.sh) ───────────────────────
LAUNCHD_HOUR=2
LAUNCHD_MINUTE=0

# ─── Cleanup retention ───────────────────────────────────────────────────
LOG_RETENTION_DAYS=30
RAW_CHATS_RETENTION_DAYS=30
DEV_LOG_MAX_MB=10

# ─── Local overrides ─────────────────────────────────────────────────────
# Sourced last so it can override any default above. Gitignored so private
# paths and personal preferences never land in commits.
__config_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$__config_dir/config.local.sh" ]]; then
  # shellcheck source=./config.local.sh
  source "$__config_dir/config.local.sh"
fi
unset __config_dir
