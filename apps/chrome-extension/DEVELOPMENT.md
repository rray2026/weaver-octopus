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
# In one terminal: vite watch + emit a fresh dist/build_id.txt every build
WEAVER_DEV=1 pnpm --filter @weaver-octopus/chrome-extension dev
```

Background SW polls `build_id.txt` every 2s; on change it
`chrome.runtime.reload()`s itself, then the new SW refreshes every tab
matched by `host_permissions`. End result: edit → save → ~2-3s later
the tab is on the freshly-built code, no clicking required.

Production builds (`pnpm build` without `WEAVER_DEV`) leave the dev
constant `__WEAVER_DEV__` false, so the poller / installer hook are
tree-shaken away — no extra requests, no extra storage keys.

### Other speed-up knobs

- **Backfill interval**: in the popup, the 间隔 inputs accept `0 ~ 0` —
  zero-pace backfill burns through chats as fast as the orchestrator can
  process them. Useful when iterating on Claude fetch-mode logic.
- **Targeted tests**: `pnpm --filter @weaver-octopus/chrome-extension test path/to/file` —
  e.g. `... runner.test.ts` only re-runs that suite (~1s vs 5s for all).
- **DevTools console filter**: paste `[weaver` into the filter input on
  any page console / SW console to see only our logs. Each subsystem
  has its own prefix:
  - `[weaver:intercept]` MAIN-world fetch patch
  - `[weaver:orch]` Claude intercept orchestrator
  - `[weaver:claude-fetch]` Claude fetch orchestrator
  - `[weaver:gemini]` Gemini orchestrator
  - `[weaver:claude-headers]`, `[weaver:claude-stale]`
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
