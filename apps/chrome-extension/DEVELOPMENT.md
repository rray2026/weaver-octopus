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

## Project structure

```
apps/chrome-extension/
├── public/
│   └── manifest.json          # Manifest V3 config
├── src/
│   ├── types/index.ts         # Shared TypeScript types
│   ├── background/index.ts    # Service worker
│   ├── content/
│   │   ├── index.ts           # Entry point — detects claude.ai, starts orchestrator
│   │   ├── orchestrator.ts    # Main controller (observe → detect end → scrape → hash → download)
│   │   ├── hash.ts            # SHA-256 via SubtleCrypto
│   │   ├── markdown.ts        # ChatMessage[] → Markdown string + filename utilities
│   │   └── providers/
│   │       ├── types.ts       # ProviderScraper interface
│   │       └── claude.ts      # Claude DOM selectors & scraping logic
│   └── popup/
│       └── index.ts           # Popup UI logic
├── popup.html                 # Popup HTML (references src/popup/index.ts via Vite)
└── vite.config.ts
```

## Architecture & data flow

```
claude.ai tab
  └─ content.js (injected by manifest)
       └─ ClaudeScraper
       └─ Orchestrator
            │  MutationObserver on document.body
            │  ↓ DOM mutation fires
            │  isStreaming()? → yes: reset 600ms timer, wait
            │                 → no:  wait 600ms, then capture()
            │
            └─ capture()
                 scrapeMessages()          — get ALL messages from DOM
                 slice(initialMessageCount) — keep only today's (new since page load)
                 messagesToMarkdown()       — serialize to Markdown string
                 hashString()              — SHA-256 of markdown
                 compare with lastHash     — skip if unchanged
                 sendMessage(DOWNLOAD_REQUEST, filename, content)
                        │
                        ▼
              background.js (service worker)
                 Blob → URL.createObjectURL()
                 chrome.downloads.download({ conflictAction: 'overwrite' })
                        │
                        ▼
              ~/Downloads/weaver-octopus/YYYY-MM-DD/<title>.md
```

## Key design decisions

### Today-only messages
`initialMessageCount` is set on the very first scrape (page load). All messages at indices `>= initialMessageCount` are treated as "today's". This works without timestamps: historical messages from previous days are simply ignored. If the user opens a fresh chat, `initialMessageCount = 0` and all messages are captured.

### Streaming detection
The orchestrator checks for `[data-testid="stop-button"]` before every scheduled capture. If it exists, the response is still being generated — the 600ms timer resets and no capture runs. This prevents partial or mid-stream Markdown files.

### Hash deduplication
After each capture, the SHA-256 of the full Markdown string is stored in `lastHash` (module variable, lives for the tab's lifetime). If the next capture produces the same hash, the download is skipped silently.

### File overwrite
`chrome.downloads.download` is called with `conflictAction: 'overwrite'` and `saveAs: false`. Chrome creates intermediate directories automatically (`weaver-octopus/YYYY-MM-DD/`).

## Types

### `src/types/index.ts`

```ts
type Provider = 'claude'

interface ChatMessage {
  id: string           // "user-0", "assistant-1", etc. (positional, stable per page load)
  role: 'user' | 'assistant'
  content: string      // plain text from DOM (.textContent)
  timestamp: number    // Date.now() at time of scrape (not a true per-message timestamp)
}

interface ChatSession {
  id: string           // crypto.randomUUID() — not currently used, reserved for future storage
  provider: Provider
  url: string
  title: string
  messages: ChatMessage[]
  capturedAt: number
  updatedAt: number
}

// Messages sent from content script → background service worker
type ContentToBackgroundMessage =
  | { type: 'SESSION_UPDATE'; session: ChatSession }
  | { type: 'SESSION_START'; session: ChatSession }
  | { type: 'DOWNLOAD_REQUEST'; filename: string; content: string }
```

### `ProviderScraper` interface (`src/content/providers/types.ts`)

```ts
interface ProviderScraper {
  isStreaming(): boolean         // true while Stop button is visible
  scrapeMessages(): ChatMessage[] // returns ALL messages currently in DOM
  getTitle(): string             // chat title for filename and Markdown heading
}
```

## DOM selectors (Claude — may break on UI updates)

| What | Selector | Notes |
|------|----------|-------|
| User message | `[data-testid="user-message"]` | |
| AI message | `.font-claude-message` | Fallback: `[data-testid="assistant-message"]` |
| Streaming in progress | `[data-testid="stop-button"]` | Absence = generation complete |
| Chat title | `document.title` | Strip ` - Claude` / ` – Claude` suffix |

**If scraping breaks after a Claude UI update**, open DevTools on `claude.ai`, inspect a user message and an AI response, and update the selectors in `src/content/providers/claude.ts`. The `scrapeMessages()` method sorts all matched elements by DOM position using `compareDocumentPosition`, so adding new selectors is safe.

## Markdown output format

```markdown
# Chat Title

**Provider**: claude
**Captured**: 2026-04-28
**URL**: https://claude.ai/chat/abc123

---

## User

User's message text

---

## Assistant

Claude's response text

---
```

File path: `~/Downloads/weaver-octopus/YYYY-MM-DD/<sanitized-title>.md`

Filename sanitization: characters `/ \ : * ? " < > |` are replaced with `-`, truncated to 200 chars.

## Debugging

### Check content script is running
Open DevTools on `claude.ai` → Console → look for:
```
[weaver-octopus] ...
```
If nothing appears, the extension may not be injected — verify `claude.ai` matches the manifest's `content_scripts[].matches`.

### Check background service worker
`chrome://extensions` → click **Service Worker** link on the extension card → opens a separate DevTools window for the background context. Check the Console for errors.

### Inspect downloaded files
Open `~/Downloads/weaver-octopus/` — subdirectories are named by date (`YYYY-MM-DD`).

### Test scraping manually
In the `claude.ai` DevTools console:
```js
// Check user messages
document.querySelectorAll('[data-testid="user-message"]')

// Check AI messages
document.querySelectorAll('.font-claude-message')

// Check streaming state
document.querySelector('[data-testid="stop-button"]')
```

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No file downloaded after response | DOM selectors changed | Update selectors in `providers/claude.ts`, rebuild |
| File downloaded mid-stream | Stop button selector changed | Update `isStreaming()` in `providers/claude.ts` |
| File contains historical messages | `initialMessageCount` baseline wrong | Check `scrapeMessages()` returns correct count on page load |
| `chrome.downloads` permission error | Missing permission | Verify `"downloads"` is in `manifest.json` permissions array |
| Build error after editing | TypeScript error | Run `pnpm --filter @weaver-octopus/chrome-extension type-check` |

## Adding support for another provider

1. Create `src/content/providers/<name>.ts` implementing `ProviderScraper`
2. Add the provider's hostname to `src/content/index.ts`
3. Add the URL pattern to `content_scripts[].matches` and `host_permissions` in `public/manifest.json`
4. Update `Provider` type in `src/types/index.ts`
5. Rebuild and reload the extension
