# Step 2/3 — Digest yesterday's chats

You loaded the world-weaver schema and current state in step 1. Now turn yesterday's AI conversations into knowledge entries.

## Input

- **Date**: ${DIGEST_DATE}
- **Raw chats directory**: `${RAW_DIR}`
- **File count**: ${CHAT_COUNT}

Each file is a markdown export of one conversation, named `[<provider>] <title>-<id8>.md`. The body is structured as `## User` / `## Assistant` blocks with frontmatter declaring provider, captured date, URL, etc.

## Per-file decision rules

For each `.md` in `${RAW_DIR}`, decide one of:

1. **Discard** if any of these holds:
   - Pure tooling / debugging (e.g. "why does my chrome extension hang", "fix this TypeScript error", "why is my SW throttled")
   - Trivial Q&A with no follow-up (single-turn factual lookup)
   - Already covered by a recent inbox entry from the last 7 days that clearly subsumes the topic

2. **Cross-platform merge**: if you find the same question asked across providers (e.g. the user asked claude AND gemini about "东亚文化圈对比"), treat them as **one inbox entry**. Pick the most-developed conversation as the primary, optionally cite the others' angles.

3. **Classify** the kept content:
   - Knowledge-bearing (stable mechanism, public knowledge) → write to `inbox/` AND create/update `knowledge/<discipline>/<entry>.md`
   - Personal context (life decisions, preferences, autobiographical) → write to `inbox/` AND create/update under `personal/<category>/`
   - Mixed → both, with `[[]]` cross-links

## Schema rules (must follow exactly — these come from `CLAUDE.md`)

### inbox file
- Filename: `${DIGEST_DATE//-/}<topic>.md`. Note `${DIGEST_DATE}` formatted **without dashes** as the prefix per the existing convention (look at `inbox/` from step 1).
- Frontmatter:
  ```yaml
  ---
  created: <YYYY-MM-DD HH:MM:SS in UTC+8 — use the conversation's max timestamp if the chat was during yesterday, else 09:00 of yesterday>
  tags: [...]   # ONLY tags already in personal/tags.md, OR new ones you ALSO add to tags.md
  ---
  ```
- Body: discussion summary → core conclusions → `## 本次创建或更新的知识条目` with `[[]]` links into `knowledge/`.

### knowledge entry
- Per-discipline frontmatter with `tags`, `type` (controlled by `personal/types.md`), `created`, optionally `data_as_of`.
- New entry → also append a one-line bullet to the discipline's `index.md`:
  `- [[条目名]]: 一句话核心主题`
- Update entry → bump nothing in frontmatter (a hook auto-stamps `updated`).

### controlled vocabularies
- Adding a new tag → it MUST be appended to `personal/tags.md` in the same change.
- Adding a new type → it MUST be appended to `personal/types.md`.

### links
- Default to bare `[[条目名]]` (Obsidian basename resolution). Use full paths only for `personal/` entries or true name collisions.

## Output

After processing all files, print a digest summary. Step 3 reads this exact summary as the PR body, so format matters:

```markdown
## Daily digest ${DIGEST_DATE}

**Processed**: ${CHAT_COUNT} files

### Created / updated
- inbox/<filename>: <one-line gist>
- knowledge/<discipline>/<entry>: <one-line gist> (new|updated)
- personal/...

### Skipped
- <filename>: <reason>
- ...

### Schema additions
- New tags: ...
- New types: ...
- New disciplines / personal categories: ...

### Note
<Optional: anything that looked weird, ambiguous classifications you punted on, or follow-ups for the human reviewer.>
```

**Do not** run `git add`, `git commit`, or `git push` in this step — that's step 3's job. **Do** make all your file edits in the working tree so the next step can see them.
