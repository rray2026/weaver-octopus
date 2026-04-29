# Chrome Extension — Development & Debugging Guide

Manifest V3 extension that monitors `claude.ai` and auto-downloads today's chat as Markdown.

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

## Project structure

```
apps/chrome-extension/
├── public/
│   └── manifest.json            # Manifest V3 config
├── src/
│   ├── types/index.ts           # Shared TypeScript types
│   ├── background/index.ts      # Service worker — handles DOWNLOAD_REQUEST
│   ├── content/
│   │   ├── index.ts             # Entry — detects claude.ai, starts orchestrator
│   │   ├── orchestrator.ts      # Consumes intercepted payloads → markdown → download
│   │   ├── hash.ts              # SHA-256 via SubtleCrypto (per-conversation dedup)
│   │   ├── markdown.ts          # ChatMessage[] → Markdown string + filename utilities
│   │   ├── main-world/
│   │   │   └── intercept.ts     # MAIN-world fetch monkey-patch (zero extra requests)
│   │   └── providers/
│   │       ├── types.ts         # ProviderParser interface
│   │       └── claude.ts        # Claude API payload → ConversationData
│   └── popup/
│       └── index.ts             # Popup — shows last download
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
