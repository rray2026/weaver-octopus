# Chrome lifecycle helpers + RPC convenience.
#
# Why restart Chrome at the start of every run: macOS App Nap + Chrome's
# per-tab throttling can leave inactive renderers paused such that
# chrome.tabs.sendMessage from the SW hangs indefinitely. The cleanest
# way to clear that state is a full quit + relaunch. See
# apps/chrome-extension/DEVELOPMENT.md for the diagnosis trail.

# Globals expected to be set by orchestrator before sourcing:
#   $RPC_BASE              — e.g. http://127.0.0.1:9876
#   $RPC_LOG_PATH          — absolute path the SW + server append to
#   $CHROME_EXTENSION_DIR  — absolute path to apps/chrome-extension/
# Globals this file sets:
#   $RPC_SERVER_PID        — pid of the server process if WE spawned it (else empty)

chrome_restart() {
  echo "[chrome] quitting Chrome..."
  osascript -e 'tell application "Google Chrome" to quit' 2>&1 \
    | sed 's/^/[chrome] /' || true

  # `quit` is async; wait for the process to actually exit.
  local waited=0
  while pgrep -x "Google Chrome" >/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [[ $waited -ge 20 ]]; then
      echo "[chrome] still running after 20s, force-killing"
      pkill -x "Google Chrome" || true
      break
    fi
  done

  echo "[chrome] relaunching..."
  # macOS LaunchServices sometimes returns -600 right after a quit; the
  # process is gone but the appkit-side state is still settling. Retry a
  # couple of times before giving up.
  local attempt=0
  while ! open -a "Google Chrome" 2>&1; do
    attempt=$((attempt + 1))
    if [[ $attempt -ge 3 ]]; then
      echo "[chrome] open -a failed after ${attempt} attempts" >&2
      return 1
    fi
    echo "[chrome] open -a returned non-zero, retrying in 2s (attempt ${attempt})"
    sleep 2
  done
}

# Spawn the RPC server in the background unless one is already listening.
# Sets $RPC_SERVER_PID only when WE started it (so the trap can kill only
# our own child, not steal a user-managed server).
rpc_ensure_server() {
  if curl -sf "$RPC_BASE/status" >/dev/null 2>&1; then
    echo "[rpc] server already running at $RPC_BASE — reusing"
    return 0
  fi

  echo "[rpc] starting server (log → $RPC_LOG_PATH)..."
  EXT_DEV_RPC_LOG_PATH="$RPC_LOG_PATH" \
    pnpm --silent --dir "$CHROME_EXTENSION_DIR" rpc \
    >> "$RPC_LOG_PATH" 2>&1 &
  RPC_SERVER_PID=$!

  local waited=0
  while ! curl -sf "$RPC_BASE/status" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [[ $waited -ge 15 ]]; then
      echo "[rpc] server failed to come up within 15s (pid $RPC_SERVER_PID)"
      return 1
    fi
  done
  echo "[rpc] server ready at $RPC_BASE (pid $RPC_SERVER_PID, took ${waited}s)"
}

rpc_stop_if_owned() {
  if [[ -n "${RPC_SERVER_PID:-}" ]]; then
    echo "[rpc] stopping server we started (pid $RPC_SERVER_PID)"
    kill "$RPC_SERVER_PID" 2>/dev/null || true
  fi
}

# Wait for the SW to wake and finish enumerating providers — we know it's
# alive when the next /command is consumed (cmd received entry in the log).
chrome_wait_sw_alive() {
  local timeout_sec=${1:-30}
  local before
  before=$(wc -l < "$RPC_LOG_PATH" 2>/dev/null || echo 0)

  rpc_command '{"action":"diagnose"}' >/dev/null

  local waited=0
  while true; do
    sleep 1
    waited=$((waited + 1))
    local after
    after=$(wc -l < "$RPC_LOG_PATH" 2>/dev/null || echo 0)
    if [[ $after -gt $before ]] && tail -n $((after - before)) "$RPC_LOG_PATH" \
       | grep -q '"action":"diagnose"'; then
      echo "[chrome] SW alive (took ${waited}s)"
      return 0
    fi
    if [[ $waited -ge $timeout_sec ]]; then
      echo "[chrome] SW did not respond to diagnose within ${timeout_sec}s"
      return 1
    fi
  done
}

rpc_command() {
  local body="$1"
  curl -sf -X POST "$RPC_BASE/command" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

# Force-refresh Gemini's myactivity index. Without this, a per-day backfill
# for a date that already has SOME prompts in the cached index won't see
# any prompts the user typed AFTER the cache was scraped — Gemini's
# auto-refresh only fires on "no in-range days at all", not on "partially
# indexed". Returns 0 once scrapedAt jumps past the pre-call timestamp,
# 1 on timeout (non-fatal: caller continues; gemini-orchestrator will fall
# back to its own auto-refresh if the data turns out actually empty).
chrome_refresh_myactivity() {
  local timeout_sec=${1:-30}
  local before_ts
  before_ts=$(date +%s)

  rpc_command '{"action":"refresh-activity","force":true}' >/dev/null
  echo "[chrome] myactivity refresh requested"

  local waited=0
  while true; do
    rpc_command '{"action":"dump-storage","keys":["geminiActivity"]}' >/dev/null
    sleep 3
    waited=$((waited + 3))

    # Find the latest scrapedAt and convert to epoch seconds.
    local scraped_iso
    scraped_iso=$(tail -n 80 "$RPC_LOG_PATH" 2>/dev/null \
      | grep '"dump-storage",{"geminiActivity"' \
      | tail -1 \
      | grep -oE '"scrapedAt":"[^"]+"' \
      | tail -1 \
      | cut -d'"' -f4)
    if [[ -n "$scraped_iso" ]]; then
      # ISO is UTC (trailing Z); `date -j -f` would otherwise interpret it
      # as local time and we'd be 8 hours off in CST.
      local scraped_ts
      scraped_ts=$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${scraped_iso%%.*}" '+%s' 2>/dev/null || echo 0)
      if [[ "$scraped_ts" -gt "$before_ts" ]]; then
        echo "[chrome] myactivity refreshed (scrapedAt=$scraped_iso)"
        return 0
      fi
    fi
    if [[ $waited -ge $timeout_sec ]]; then
      echo "[chrome] myactivity refresh timed out after ${timeout_sec}s — continuing anyway"
      return 1
    fi
  done
}

# Poll backfillProgress.state until it transitions to a terminal state
# ("done" or "idle"), or we hit the timeout. Returns 0 on done, 1 on
# timeout. Uses the dev runtime log to read the dump-storage response.
chrome_wait_backfill_done() {
  local timeout_min=${1:-10}
  local timeout_sec=$((timeout_min * 60))
  local started
  started=$(date +%s)
  local poll_interval=5

  while true; do
    rpc_command '{"action":"dump-storage","keys":["backfillProgress"]}' >/dev/null
    sleep "$poll_interval"

    # Pull the state from the most recent dump-storage RESPONSE line.
    # The poller sees both "received" and "dump-storage" entries — only the
    # latter carries the actual storage payload. The backfillProgress JSON
    # is nested (recentLog entries close braces before `state` appears),
    # so a `[^}]*`-style match bails too early; we instead just grep for
    # any "state":"..." in the response line.
    local state
    state=$(tail -n 200 "$RPC_LOG_PATH" 2>/dev/null \
      | grep '"dump-storage",{"backfillProgress"' \
      | tail -1 \
      | grep -oE '"state":"[^"]+"' \
      | tail -1 \
      | cut -d'"' -f4)

    if [[ "$state" == "done" || "$state" == "idle" ]]; then
      echo "[chrome] backfill state=$state"
      return 0
    fi

    local elapsed=$(($(date +%s) - started))
    if [[ $elapsed -ge $timeout_sec ]]; then
      echo "[chrome] backfill timed out after ${timeout_min} minutes (last state=${state:-unknown})"
      return 1
    fi
  done
}
