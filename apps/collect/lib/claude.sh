# Wrappers for invoking Claude Code CLI in non-interactive mode with a
# shared session, so step 2/3 can leverage the context loaded by step 1
# without re-scanning the world-weaver tree.

# Run claude -p with a fixed --session-id (UUID we picked ourselves). Each
# call resumes the same conversation. Step 1 establishes the session;
# steps 2 and 3 resume it.
#
# Args:
#   $1 — prompt file path (will be cat'd through envsubst for ${RAW_DIR}, etc.)
#   $2 — "first" for the initial call, "resume" for follow-ups
#   $3 — output format: "text" (default) or "json"
#
# Globals:
#   $CLAUDE_SESSION_ID  — set on first call (a UUID)
#   $WORLD_WEAVER_PATH  — absolute path; claude is invoked with this as cwd
claude_run() {
  local prompt_file="$1"
  local mode="${2:-resume}"
  local output_format="${3:-text}"
  local timeout_sec="${4:-1800}"

  if [[ ! -f "$prompt_file" ]]; then
    echo "[claude] prompt file missing: $prompt_file" >&2
    return 1
  fi

  # Expand ${VAR} references using perl (always present on macOS, unlike
  # gettext's envsubst). Only ${VAR} form is substituted; bare $VAR is left
  # alone so prose like "$5" or "$(...)" in prompts isn't mangled.
  local prompt
  prompt=$(perl -pe 's/\$\{(\w+)\}/exists $ENV{$1} ? $ENV{$1} : "\${$1}"/ge' < "$prompt_file")

  local args=(--print --permission-mode bypassPermissions --output-format "$output_format")
  if [[ "$mode" == "first" ]]; then
    : "${CLAUDE_SESSION_ID:?CLAUDE_SESSION_ID must be set before first claude call}"
    args+=(--session-id "$CLAUDE_SESSION_ID")
  else
    args+=(--resume "$CLAUDE_SESSION_ID")
  fi

  # Hard timeout: a hung claude --print would otherwise occupy the
  # LaunchAgent slot indefinitely (verified live — Mac sleeping mid-run
  # left a Step 1 claude wedged for 8 hours, blocking the next morning's
  # automated run). Bash watchdog: spawn the call backgrounded, fork a
  # sleeper that SIGTERMs (then SIGKILLs) on expiry, wait on the call.
  ( cd "$WORLD_WEAVER_PATH" && exec claude "${args[@]}" "$prompt" ) &
  local cmd_pid=$!
  ( sleep "$timeout_sec"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      echo "[claude] timeout ${timeout_sec}s exceeded — sending SIGTERM to $cmd_pid" >&2
      kill -TERM "$cmd_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$cmd_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!
  local rc=0
  wait "$cmd_pid" || rc=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$rc"
}

# Generate a UUID for the session. Mac has uuidgen built in.
claude_new_session_id() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}
