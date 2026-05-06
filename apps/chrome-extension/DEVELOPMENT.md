# Chrome Extension — Development & Debugging Guide

Manifest V3 extension that monitors `claude.ai` and `gemini.google.com` and
auto-downloads today's chat as Markdown.

| Provider | Capture mechanism | Date filtering |
|----------|------------------|----------------|
| Claude   | MAIN-world fetch interception | popup-controlled range (today / yesterday / last 7 days / this week / custom) |
| Gemini   | DOM scraping + MutationObserver | always today (cross-referenced against `myactivity.google.com/product/gemini`) |

Gemini ignores the popup's date filter — Gemini's DOM has no per-message
timestamp, so the only reliable "this turn happened today" signal is the
prompt list scraped from myactivity. The extension auto-opens
`myactivity.google.com/product/gemini` in a background tab on demand.

## Build

```bash
# From repo root
pnpm install
pnpm --filter @weaver-octopus/chrome-extension build

# Watch mode (auto-rebuild on save)
pnpm --filter @weaver-octopus/chrome-extension dev
```

Output: `dist/` — load this folder as an unpacked extension in Chrome.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select `apps/chrome-extension/dist/`
4. After each rebuild → click **↺** on the extension card → refresh `claude.ai` tab

> Reloading the extension without refreshing the tab leaves the old content
> script running with an invalidated `chrome.runtime` context. The orchestrator
> detects this case, prints one warning, and stops processing further events.

## Hot-reload dev workflow (no manual ↺ + tab refresh)

```bash
# Terminal A: vite watch + emit dist/build_id.txt + patch manifest with
#             http://127.0.0.1/* host permission so the SW can talk to the
#             dev-log-server (next terminal).
pnpm --filter @weaver-octopus/chrome-extension dev:hot

# Terminal B: HTTP loopback server. Receives forwarded console.* lines and
#             serves a /command queue the dev-trigger CLI writes to.
pnpm --filter @weaver-octopus/chrome-extension dev:logs

# Terminal C (optional): tail the runtime log
tail -F apps/chrome-extension/.dev-runtime.log
```

Edit → save → ~2–3s later the extension auto-reloads, matched tabs
auto-refresh, and every `console.log/info/warn/error` from the SW,
content scripts and popup ends up in `.dev-runtime.log` as JSONL,
keyed by `source` (e.g. `background`, `content:claude.ai`, `popup`).

### Driving specific scenarios from outside the browser

The same dev-log-server hosts a small `/command` queue the SW polls
every 1.5s. Push a JSON command into it and the SW dispatches the same
helpers the popup uses:

```bash
# Start a backfill on Claude only with zero pacing
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"start-backfill","providers":["claude"],"intervalMinSec":0,"intervalMaxSec":0}'

# Stop the in-flight batch
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"stop-backfill"}'

# Wipe every cache key (convHashes / lastDownload / todayGemini /
# backfillProgress)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"reset-cache"}'

# Open a URL in a new tab (e.g. force a SPA fetch)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"open","url":"https://claude.ai/chat/abc..."}'

# Force a full extension reload (rarely needed — auto-reload covers most)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger '{"action":"reload"}'

# Read selected (or all) keys from chrome.storage.local
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"dump-storage","keys":["todayGemini","convHashes"]}'

# Dump the active claude.ai / gemini.google.com tab's chat DOM —
# selector hit counts + first-match outerHTML truncated, scrapeTurns
# output, sidebar links the backfill adapter would enumerate. Useful
# when SPA changes break selectors. `target` optional ('claude'|'gemini').
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"snapshot-dom","target":"gemini"}'

# One-shot health report: extension version + permissions + open tabs +
# storage summary (large keys truncated, sensitive values redacted).
pnpm --filter @weaver-octopus/chrome-extension dev:trigger '{"action":"diagnose"}'
```

Each command is logged into `.dev-runtime.log` along with whatever the
SW prints while executing it, so a dev session looks like:
1. trigger an action
2. read the log (just `tail -F` or the Read tool)
3. see what the orchestrator decided

Production builds (`pnpm build`) leave `__WEAVER_DEV__` false, so the
auto-reload poller, log forwarder, command poller, and the
http://127.0.0.1/* permission are all absent — no extra requests, no
extra storage keys, no dev surface in the shipped bundle.

### ⚠️ After every `pnpm build` (production), rebuild dev

`pnpm build` (prod) overwrites `dist/` with code that has `__WEAVER_DEV__`
folded to false — dev infrastructure (auto-reload poller, log forwarder,
command poller) is tree-shaken out. The auto-reload poller still in the
running SW notices the changed `build_id` and reloads, **landing the
prod dist as the live extension**. From that moment, `dev:trigger`
returns 202 but the command sits unconsumed because no one is polling
`/command`.

Recovery:

```bash
pnpm --filter @weaver-octopus/chrome-extension build:dev
# wait for the running SW's auto-reload poller to land it; if the SW
# itself was prod (no poller), click ↺ on chrome://extensions
```

Better: run `pnpm dev:hot` for the whole session (it stays in dev) and
only run `pnpm build` once, just before pushing.

### Debugging methodology that worked in this codebase

Sequence that consistently led to root cause:
1. **Reproduce in the wild via dev:trigger**, never click through the UI.
2. **Compare two runs of the same scenario.** Same input, different
   outcome → the orchestrator depends on something non-deterministic
   (DOM hydration timing, storage state, etc.). The Gemini "downloads
   whole historical chat" and "today chat now skipped" bugs both showed
   up this way.
3. **Dump the relevant chrome.storage.local keys.** `dev:trigger
   '{"action":"dump-storage","keys":[...]}'`. If a chat was processed
   differently across runs, look at `todayGemini` / `convHashes` and see
   what changed.
4. **Add the smallest extra log that turns the bug from invisible to
   obvious.** Examples we added mid-session:
   - `slice composition` on the Gemini orchestrator's success path so we
     could correlate downloads with `today.prompts.length`.
   - `traceSliceMismatch` on the skip path with per-turn-vs-per-prompt
     verdict (EQUAL / TRUNCATED-PREFIX / no).
   - Source-tagged log lines (`background` / `content:gemini.google.com`
     / `popup`) — `grep` on `source` narrows fast.
5. **Walk the math.** If `slice=29` from `todayPromptsLen=1`, that's
   mathematically impossible from `computeTodaySlice` alone (`minIdx`
   strictly increases) → the matcher isn't where the bug is. Trace
   pointed to the `newSession` fallback instead.
6. **Land the fix as a unit test first.** Both Gemini bugs have
   regression tests in `gemini.test.ts` named after the failure mode.

### MV3 service-worker keepalive — known limit

The dev infrastructure uses two layers to keep the SW alive:
- `setInterval`-driven long-poll fetch to `:9876/command` (in-flight
  fetch counts as activity).
- `chrome.alarms` keepalive every 30s (the listener is a no-op; the
  wake-up itself re-runs module top-level which restarts the long-poll).

Both fail when Chrome decides the extension is *deeply* idle (laptop
sleep, system suspend, very long inactivity). When that happens, the
log file goes silent and queued commands sit unconsumed.

Recovery (manual):
- Click the extension's **Service Worker** link in `chrome://extensions`,
  OR open the popup, OR refresh `claude.ai` / `gemini.google.com` —
  any of these wakes the SW, which re-establishes the long-poll within
  ~1 second.

If you see `dev:trigger` return 202 but no command-execution log
appears within ~3s, the SW is asleep. Use one of the above.

### Other speed-up knobs

- **Backfill interval**: in the popup, the 间隔 inputs accept `0 ~ 0` —
  zero-pace backfill burns through chats as fast as the orchestrator can
  process them. Useful for fast iteration in tests; not recommended in
  real use (risk of rate limiting).
- **Targeted tests**: `pnpm --filter @weaver-octopus/chrome-extension test path/to/file` —
  e.g. `... runner.test.ts` only re-runs that suite (~1s vs 5s for all).
- **DevTools console filter**: paste `[weaver` into the filter input on
  any page console / SW console to see only our logs. Each subsystem
  has its own prefix:
  - `[weaver:intercept]` MAIN-world fetch patch
  - `[weaver:orch]` Claude intercept orchestrator
  - `[weaver:gemini]` Gemini orchestrator
  - `[weaver:claude-stale]` cache invalidation on chat mutations
  - `[weaver:bg]` background coordinator
  - `[weaver:backfill]` backfill runner
  - `[weaver:dev-autoreload]` hot-reload poller
- **Slice-mismatch trace**: when Gemini logs `skip: nothing in today
  slice`, it follows up with a per-turn EQUAL/no diff — read those lines
  to see exactly why a chat was excluded.

## Project structure

```
apps/chrome-extension/
├── public/
│   └── manifest.json            # Manifest V3 config
├── src/
│   ├── types/index.ts           # Shared TypeScript types
│   ├── background/index.ts      # Service worker — handles DOWNLOAD_REQUEST + REFRESH_ACTIVITY
│   ├── content/
│   │   ├── index.ts             # Entry — branches on hostname (claude.ai vs gemini.google.com)
│   │   ├── orchestrator.ts      # Claude: consumes intercepted payloads → markdown → download
│   │   ├── gemini-orchestrator.ts # Gemini: MutationObserver → DOM scrape → markdown → download
│   │   ├── hash.ts              # SHA-256 via SubtleCrypto (per-conversation dedup)
│   │   ├── markdown.ts          # ChatMessage[] → Markdown string + filename utilities
│   │   ├── main-world/
│   │   │   └── intercept.ts     # MAIN-world fetch monkey-patch (Claude only, zero extra requests)
│   │   └── providers/
│   │       ├── types.ts         # ProviderParser interface
│   │       ├── claude.ts        # Claude API payload → ConversationData
│   │       └── gemini.ts        # Pure DOM scraping helpers for Gemini
│   ├── myactivity/
│   │   ├── index.ts             # Content script for myactivity.google.com/product/gemini
│   │   └── scraper.ts           # Pure helpers — find Today header, extract prompts
│   └── popup/
│       └── index.ts             # Popup — shows last download (Claude filter only)
├── popup.html
└── vite.config.ts
```

## Architecture & data flow

The extension is **passive**: it never issues its own HTTP requests. It hooks
`window.fetch` in the page's MAIN world and clones successful responses to
Claude's own conversation API, then forwards the JSON to the isolated content
script via `postMessage`.

```
claude.ai tab
  ├─ intercept.js (MAIN world, run_at: document_start)
  │     monkey-patches window.fetch
  │     on response to /api/organizations/<org>/chat_conversations/<id>:
  │       clone() → json() → window.postMessage({ source, type, conversationId, body })
  │
  └─ content.js (ISOLATED world, run_at: document_idle)
        startOrchestrator(new ClaudeParser())
          ↓ window.addEventListener('message', …)
        handleConversation(msg)
          ├─ ClaudeParser.parseConversation(msg.body)  → ConversationData
          ├─ filter messages where createdAt >= today 00:00 (local)
          ├─ messagesToMarkdown(todayMessages, title, url)
          ├─ SHA-256(markdown) — skip if unchanged for this conversationId
          └─ chrome.runtime.sendMessage({ type: 'DOWNLOAD_REQUEST', filename, content })
                  │
                  ▼
        background.js (service worker)
          ├─ verify sender.tab.url starts with https://claude.ai/
          ├─ chrome.downloads.download({ url: data:text/markdown;…, filename, conflictAction: 'overwrite' })
          └─ chrome.storage.local.set({ lastDownload: { filename, at } })
                  │
                  ▼
        ~/Downloads/weaver-octopus/YYYY-MM-DD/[claude] <title>-<convId8>.md
```

For Gemini the path is parallel but driven by the DOM, not by intercepted fetches:

```
gemini.google.com tab
  └─ content.js (ISOLATED, run_at: document_idle)
        startGeminiOrchestrator()
          ├─ MutationObserver on body  → debounce 1.5s → runExport()
          ├─ history.pushState/replaceState patched → reset state on chat switch
          └─ runExport()
                ├─ scrapeTurns(document)        — selector list w/ fallback
                ├─ getConversationIdFromUrl()   — null on welcome page → skip
                ├─ isLastTurnIncomplete()       — wait if model is still streaming
                ├─ split turns: [history before this tab opened] vs [newSession in this tab]
                ├─ chrome.storage.local.get('todayGemini')
                │     missing/stale → chrome.runtime.sendMessage({type:'REFRESH_ACTIVITY'})
                │     background opens/reloads myactivity tab in background → wait → retry
                ├─ computeTodaySlice(history, todayPrompts)  — match user prompts in newest-first order
                ├─ slice = existingToday ∪ newSession
                ├─ in-tab fingerprint dedup + cross-tab SHA-256 (key 'gemini:<convId>')
                └─ chrome.runtime.sendMessage({ type:'DOWNLOAD_REQUEST', filename, content })

myactivity.google.com/product/gemini tab
  └─ myactivity.js (ISOLATED, run_at: document_idle)
        MutationObserver → debounce 1.2s → collectTodayPrompts(document)
          → chrome.storage.local.set({ todayGemini: { date, prompts } })

        ~/Downloads/weaver-octopus/YYYY-MM-DD/[gemini] <title>-<convId8>.md
```

## Key design decisions

### Zero extra requests
We hook `window.fetch` from the MAIN world rather than calling Claude's API
ourselves. Pros: no extra load, no auth handling, no CORS, no rate-limit risk.
Cons: we capture only what the user's UI happens to fetch — opening a chat
fires the GET, but if the SPA caches and skips the request on revisit, we won't
re-capture until something invalidates the cache. In practice this is fine
because the UI re-fetches after each turn.

### Today-only filter
`m.createdAt >= todayStart` (local midnight). Each message has a real
`created_at` ISO timestamp from the API, so historical messages are reliably
excluded — no DOM-based heuristics, no "baseline message count" needed.

### Per-conversation hash dedup
`Map<conversationId, sha256>` keyed by the conversation UUID. Switching
between chats won't suppress a fresh capture, and the same conversation won't
re-download identical content.

### Filename collision
Filename is `[claude] <sanitized-title>-<convId first 8>.md`. Two different chats with
the same title on the same day won't overwrite each other.

### Data URL for download
`chrome.downloads.download` is invoked with a `data:text/markdown;…` URL.
Blob URLs created inside an MV3 service worker silently fail on some Chrome
versions; data URLs are universally supported.

### Async race lock
`captureInFlight` prevents two overlapping `handleConversation` calls from
both passing the hash check before either updates the map.

### Extension-context-invalidated handling
When the extension is reloaded but the tab is not refreshed,
`chrome.runtime.sendMessage` throws "Extension context invalidated". The
orchestrator detects this string, logs one `console.warn` asking the user to
refresh, and silently ignores all subsequent events.

## Types

### `src/types/index.ts`

```ts
type Provider = 'claude'

interface ChatMessage {
  id: string           // provider's message uuid
  role: 'user' | 'assistant'
  content: string      // text from API content blocks (joined with \n\n)
  createdAt: number    // ms since epoch, parsed from ISO created_at
}

type ContentToBackgroundMessage = {
  type: 'DOWNLOAD_REQUEST'
  filename: string
  content: string
}

interface LastDownload {
  filename: string
  at: number           // ms since epoch
}
```

### `ProviderParser` interface (`src/content/providers/types.ts`)

```ts
interface ProviderParser {
  parseConversation(body: unknown, url: string, fallbackTitle: string): ConversationData | null
}

interface ConversationData {
  title: string
  url: string
  messages: ChatMessage[]
}
```

## Watched API endpoints (Claude — may break on backend changes)

| What | Match | Notes |
|------|-------|-------|
| Conversation fetch | `/api/organizations/<uuid>/chat_conversations/<uuid>` | GET only; must contain `chat_messages` array |

The regex lives in `src/content/main-world/intercept.ts`. If Claude renames
the endpoint or splits it across multiple requests, intercept needs updating.

## Markdown output format

```markdown
# Chat Title

**Provider**: claude
**Captured**: 2026-04-29
**URL**: https://claude.ai/chat/abc123

---

## User

User's message text

---

## Assistant

Claude's response text

---
```

File path: `~/Downloads/weaver-octopus/YYYY-MM-DD/[claude] <sanitized-title>-<convId8>.md`

Filename sanitization: characters `/ \ : * ? " < > |` are replaced with `-`,
truncated to 200 chars; conversation id's first 8 hex chars are appended
before `.md`.

## Debugging

### Check intercept is installed
Open DevTools on `claude.ai` → Console. Type:
```js
__weaverFetchPatched
```
Should print `true`.

### Check orchestrator is running
Look for `[weaver] orchestrator started` in the page console after refresh.

### Trigger a capture without sending a message
Send any message in a chat, or open/refresh a chat — Claude's UI re-fetches
the conversation. Look for:
```
[weaver] download: weaver-octopus/2026-04-29/<title>-<id>.md (3/3 from today)
```

### Background service worker
`chrome://extensions` → click **Service Worker** link on the extension card →
opens DevTools for the background context. Look for `[weaver] download
started id=…`.

### Inspect downloaded files
`~/Downloads/weaver-octopus/` — subdirectories named by date (`YYYY-MM-DD`).

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `__weaverFetchPatched` is undefined | `intercept.js` not loaded in MAIN world | Verify `manifest.json` content_scripts entry has `world: "MAIN"`, `run_at: "document_start"` |
| `[weaver] orchestrator started` missing | content.js not injected | Confirm host matches `https://claude.ai/*` |
| No download after sending a message | Claude API URL changed | Update regex in `src/content/main-world/intercept.ts` |
| `Extension context invalidated` warning | Reloaded extension without refreshing tab | Refresh the claude.ai tab |
| Empty markdown body | API content block types changed | Check `extractText()` in `providers/claude.ts` — currently only `type === 'text'` is included |
| Files overwriting each other | Two chats hash-collide on title+id8 | Increase id suffix length in `orchestrator.ts` |

## Adding support for another provider

1. Add a MAIN-world intercept entry that detects the provider's conversation API and posts a `CONVERSATION` message with `{ source, type, conversationId, body }`
2. Create `src/content/providers/<name>.ts` implementing `ProviderParser`
3. Wire the new parser into `src/content/index.ts` (`location.hostname` check)
4. Add the URL pattern to `content_scripts[].matches` and `host_permissions` in `public/manifest.json`
5. Update `Provider` type in `src/types/index.ts`
6. Rebuild and reload the extension
