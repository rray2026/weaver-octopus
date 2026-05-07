# Step 3/3 — Publish

You produced a digest summary in step 2 and made the corresponding edits in the working tree. Now publish them as a PR.

## Tasks

1. **Sanity check**: `git status --porcelain`. There should be modified / new files under `inbox/`, `knowledge/`, `personal/`. If the working tree is clean, step 2 didn't actually write anything — print "no changes to publish, exiting" and stop here.

2. **Branch**: `git checkout -b ${BRANCH}` (the orchestrator pre-checked it doesn't exist).

3. **Commit**:
   - `git add -A` (only world-weaver paths should be modified; flag and stop if anything else shows up)
   - Commit message:
     ```
     auto-digest: ${DIGEST_DATE}

     <one-paragraph summary derived from your step 2 output>
     ```

4. **Push**: `git push -u origin ${BRANCH}`.

5. **PR**: open a pull request via `gh`:
   - Title: `Daily digest ${DIGEST_DATE}`
   - Body: the **exact** digest summary you printed in step 2 (the markdown block starting with `## Daily digest ${DIGEST_DATE}`).
   - Base: the repo's default branch (usually `main`).
   - **Do not** auto-merge. The user reviews and merges manually.

6. **Output**: print the PR URL on its own line at the end so the orchestrator log shows it clearly:

```
PR: https://github.com/.../pull/N
```

If any step fails (push rejected, gh not authenticated, etc.), print the error verbatim and exit non-zero — the orchestrator will surface that in the log file.
