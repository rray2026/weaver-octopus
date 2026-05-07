# Step 1/3 — Load context

You are running inside the **world-weaver** repository (a personal Obsidian-style knowledge base) as part of an automated daily pipeline. There are 3 steps; this is step 1, where you load enough context that step 2 can act decisively.

This step **must not modify any files**. Read-only.

## Tasks

1. **Sync with origin**: run `git pull --ff-only`. If it fails (diverged history, conflicts), stop everything — `echo` the error and refuse to continue. Do not try to merge or rebase.

2. **Read the schema**: open `CLAUDE.md` and read it carefully. It defines the inbox/knowledge/personal split, the frontmatter format, the linking conventions, and the discipline taxonomy. **Internalise it — step 2 will rely on these rules without re-reading.**

3. **Survey current state** — gather these specific facts:
   - Current commit on the active branch: `git -C . log -1 --oneline`
   - Last 7 days of `inbox/` filenames (use `ls inbox/`, the date prefix is sortable)
   - Subdirectories under `knowledge/` and approximate entry counts each
   - Contents of `personal/tags.md` and `personal/types.md` (the registered controlled vocabularies)
   - Anything under `personal/` that looks like personal-info categories (`向往/`, `学习路径/`, etc.) — note them, you may need to file new entries there

4. **Report** back a concise summary in this exact format:

```
## Context loaded

- Repo: <commit hash> on <branch>
- Pull: <up-to-date | fetched N commits>
- Last 7 days inbox topics:
  - <filename or topic>
  - ...
- Knowledge disciplines: <list with counts, e.g., 艺术(8) 经济(5) ...>
- Registered tags (count): <N> (key examples: ...)
- Registered types (count): <N> (key examples: ...)
- Personal categories: <list>
```

That's it for step 1. **Do not write any files.** Step 2 will follow in this same conversation.
