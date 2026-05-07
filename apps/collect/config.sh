# Configuration for the daily collect pipeline. Sourced by orchestrator.sh.
# Pure shell so no external parser is needed (yq etc.).

# Path to the world-weaver knowledge base, relative to this file's parent OR
# absolute. Tilde is expanded; ../ is resolved against apps/collect/.
WORLD_WEAVER_PATH="../../../world/world-weaver"

# Providers to back-fill. The chrome extension's start-backfill accepts any
# subset of these.
PROVIDERS=(claude gemini chatgpt)

# Date filter passed to the extension. One of: today | yesterday | last7days
# | thisWeek | range. The pipeline is designed for "yesterday" — other values
# work but the digest prompt assumes a single-day window.
DATE_FILTER="yesterday"

# If true, quit and relaunch Chrome at the start of each run. Reliably clears
# accumulated per-tab throttling / App Nap state that otherwise hangs the
# backfill for inactive renderers (verified live, see chrome-extension
# DEVELOPMENT.md).
CHROME_RESTART_BEFORE_RUN=true

# Wait time after relaunching Chrome before declaring it ready (seconds).
# The SW + content scripts take ~5–10s to come up.
CHROME_WAIT_SECONDS=15

# Hold the system + display awake for the duration of the run via
# `caffeinate -dis`. Auto-kill on script exit.
CAFFEINATE_DURING_RUN=true

# Hard ceiling on the backfill polling loop (minutes). Beyond this we abort
# the run, leave any partial downloads in place, and skip the digest step.
BACKFILL_TIMEOUT_MINUTES=10

# Where per-day run logs are written. Created if missing.
LOG_DIR="$HOME/Library/Logs/weaver-collect"

# RPC server endpoint. Default matches the chrome-extension build:rpc bundle.
RPC_BASE="http://127.0.0.1:9876"

# Branch name template for the daily PR. {DATE} is replaced with YYYY-MM-DD
# (the date being digested, which equals "yesterday" at run time).
BRANCH_TEMPLATE="auto/digest-{DATE}"

# launchd schedule (used by launchd/install.sh). 02:00 local time.
LAUNCHD_HOUR=2
LAUNCHD_MINUTE=0
