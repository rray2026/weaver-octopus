# Pre-flight git checks. Run BEFORE the pipeline does anything irreversible.
# All functions take $1 = world-weaver absolute path.

git_assert_clean() {
  local repo="$1"
  local dirty
  dirty=$(git -C "$repo" status --porcelain)
  if [[ -n "$dirty" ]]; then
    echo "[git] $repo has uncommitted changes — refusing to run"
    echo "[git] working tree:"
    echo "$dirty" | sed 's/^/[git]   /'
    return 1
  fi
  echo "[git] working tree clean"
}

# Detect if today's auto-digest branch already exists (locally OR remotely).
# We treat existence as "already done" and bail.
git_assert_branch_unused() {
  local repo="$1"
  local branch="$2"

  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "[git] branch '$branch' already exists locally — assuming today's run already happened"
    return 1
  fi
  if git -C "$repo" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "[git] branch '$branch' already exists on origin — assuming today's run already happened"
    return 1
  fi
  echo "[git] branch '$branch' is free"
}
