# Chrome Extension — Development & Debugging Guide

Manifest V3 extension that captures conversations from `claude.ai`,
`gemini.google.com` and `chatgpt.com` as Markdown files. **Backfill-only**
— passive browsing never writes files; the user clicks 「批量回填」 in the
popup (or `dev:trigger '{"action":"start-backfill"...}'`) to drive a
sidebar walk that downloads in-range chats.

| Provider | Capture mechanism | Date attribution |
|----------|------------------|------------------|
| Claude   | MAIN-world fetch intercept on `/api/organizations/<o>/chat_conversations/<c>` | per-message `created_at` from the API |
| Gemini   | DOM scrape + MutationObserver | per-day prompt index from `myactivity.google.com/product/gemini`, matched against scraped user-turns |
| ChatGPT  | MAIN-world fetch intercept on `/backend-api/conversation/<c>` | per-message `create_time` from the API (current_node → parent walk) |

The popup's date filter (today / yesterday / last 7 days / this week /
custom range) applies to **all three providers**. For Claude and ChatGPT,
filtering is straightforward `m.createdAt >= range.start && < range.end`.
For Gemini — whose DOM has no per-turn timestamps — the multi-day
myactivity index is flattened to "every prompt logged inside the active
range" and chat user-turns are claim-once-matched against it. The
extension auto-opens / refreshes `myactivity.google.com/product/gemini`
on demand.

The download folder is the **chat's content date**, not the capture
date: a `yesterday` filter writes to `~/Downloads/.../<yesterday>/`,
not today. Determined by `max(createdAt)` over in-range messages
(Claude / ChatGPT) or `deriveChatDate` over matched myactivity prompts
(Gemini).

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
# Start a backfill on Claude only with zero pacing.
# Without intervalMinSec / intervalMaxSec the popup default 1-2s is used.
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"start-backfill","providers":["claude"],"intervalMinSec":0,"intervalMaxSec":0}'

# Multi-provider backfill (the popup checkboxes route through the same path)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"start-backfill","providers":["claude","gemini","chatgpt"]}'

# Stop the in-flight batch
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"stop-backfill"}'

# Wipe every cache key (convHashes / lastDownload / geminiActivity /
# backfillProgress)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"reset-cache"}'

# Set the date filter (popup-equivalent storage write, no popup needed).
# type ∈ today | yesterday | last7days | thisWeek | range
# For range, also pass start/end as YYYY-MM-DD strings.
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"set-filter","type":"yesterday"}'
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"set-filter","type":"range","start":"2026-04-25","end":"2026-04-29"}'

# Re-scrape myactivity.google.com (opens / reloads the tab and lets
# the scraper repopulate `geminiActivity`). `force:true` bypasses the
# 30s throttle.
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"refresh-activity","force":true}'

# Have the myactivity content script return its current scrape +
# header-candidate diagnostics — useful when geminiActivity.days is
# empty and you don't know if the page hasn't hydrated, the headers
# don't match our regex, or the c-wiz items aren't where we expect.
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"inspect-myactivity"}'

# Open a URL in a new tab (e.g. force a SPA fetch)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"open","url":"https://claude.ai/chat/abc..."}'

# Force a full extension reload (rarely needed — auto-reload covers most)
pnpm --filter @weaver-octopus/chrome-extension dev:trigger '{"action":"reload"}'

# Read selected (or all) keys from chrome.storage.local
pnpm --filter @weaver-octopus/chrome-extension dev:trigger \
  '{"action":"dump-storage","keys":["geminiActivity","convHashes","dateFilter"]}'

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
   differently across runs, look at `geminiActivity` / `convHashes` /
   `dateFilter` / `backfillProgress` and see what changed.
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
  - `[weaver:intercept]` Claude MAIN-world fetch patch
  - `[weaver:chatgpt-intercept]` ChatGPT MAIN-world fetch patch
  - `[weaver:orch:claude]` / `[weaver:orch:chatgpt]` API-driven orchestrator
    (same source file, parameterised on `{ provider, interceptSource, titleStripRe }`)
  - `[weaver:gemini]` Gemini DOM-scrape orchestrator (separate code path)
  - `[weaver:myactivity]` per-day myactivity index scraper
  - `[weaver:claude-stale]` cache invalidation on Claude chat mutations
  - `[weaver:bg]` background coordinator
  - `[weaver:backfill][<provider>]` backfill runner
  - `[ext-dev-rpc][auto-reload]` / `[ext-dev-rpc][cmd]` dev sidecar
- **Slice-mismatch trace**: when Gemini logs `skip: nothing in today
  slice`, it follows up with a per-turn EQUAL/no diff — read those lines
  to see exactly why a chat was excluded.

## Project structure

```
apps/chrome-extension/
├── public/
│   └── manifest.json            # MV3 config — host permissions + 5 content scripts
├── src/
│   ├── types/index.ts           # Provider, ChatMessage, GeminiActivityIndex, ...
│   ├── background/index.ts      # Service worker — DOWNLOAD_REQUEST + REFRESH_ACTIVITY
│   │                            #   + backfill coordinator + dev cmd handler map
│   ├── content/
│   │   ├── index.ts             # Entry — branches on hostname; wires orchestrator +
│   │   │                        #   backfill listener for each provider
│   │   ├── orchestrator.ts      # Claude + ChatGPT: intercept → parse → markdown → DL
│   │   │                        #   parameterised by { provider, interceptSource,
│   │   │                        #   titleStripRe } so both providers share one path
│   │   ├── gemini-orchestrator.ts # Gemini: MutationObserver → scrape → match-by-date
│   │   │                        #   → markdown → download (separate code path; DOM-driven)
│   │   ├── backfill-gate.ts     # In-memory `backfillInFlight` flag; orchestrator
│   │   │                        #   entries return early when false
│   │   ├── claude-stale.ts      # Hash invalidation on Claude chat mutations
│   │   ├── captureEvents.ts     # CAPTURE_DECISION CustomEvent → backfill runner
│   │   ├── dateFilter.ts        # loadFilter / saveFilter / computeRange (shared with popup)
│   │   ├── hash.ts              # SHA-256 via SubtleCrypto (per-conversation dedup)
│   │   ├── markdown.ts          # ChatMessage[] → Markdown + filename utilities
│   │   ├── main-world/
│   │   │   ├── intercept.ts          # Claude:  /api/.../chat_conversations/<uuid>
│   │   │   └── intercept-chatgpt.ts  # ChatGPT: /backend-api/conversation/<uuid>
│   │   ├── backfill/
│   │   │   ├── runner.ts        # Provider-agnostic walker — enumerate → navigate →
│   │   │   │                    #   wait-for-decision → progress patch
│   │   │   ├── claude.ts        # Claude sidebar enumeration + click navigation
│   │   │   ├── gemini.ts        # Gemini sidebar enumeration + click navigation
│   │   │   └── chatgpt.ts       # ChatGPT sidebar (`a[href^="/c/"]` + custom-GPT path)
│   │   └── providers/
│   │       ├── types.ts         # ProviderParser interface + ConversationData
│   │       ├── claude.ts        # /api/.../chat_conversations/<id> body → ConversationData
│   │       ├── chatgpt.ts       # current_node → parent walk → linear messages
│   │       └── gemini.ts        # DOM scraping helpers + slice computation
│   ├── myactivity/
│   │   ├── index.ts             # Content script for myactivity.google.com/product/gemini
│   │   └── scraper.ts           # Multi-day collector: every date header → bucketed prompts
│   ├── dev/
│   │   └── dom-snapshot.ts      # Used by snapshot-dom dev command
│   └── popup/
│       └── index.ts             # Popup — date filter + provider checkboxes + backfill
├── popup.html
└── vite.config.ts               # 5 entries: background / content / intercept / intercept-chatgpt / myactivity / popup
```

## Architecture & data flow

The extension is **passive** in two senses:

1. **No extra HTTP requests.** The MAIN-world fetch monkey-patch (Claude /
   ChatGPT) clones the SPA's own conversation reads. We never call
   `/backend-api/...` ourselves — replaying those endpoints fails the
   Cloudflare/sentinel handshake (verified live; documented commit
   message 6bbe612 / `live-capture-gate` history).

2. **Backfill-driven.** The orchestrator's processing entry checks
   `isBackfillInFlight()`. With the flag false, every observed
   conversation is dropped at the gate (logged as `skip: no backfill in
   flight`). The runner sets the flag for the duration of its tab walk
   and clears it on completion / error. Net effect: passive browsing
   produces zero downloads; only `start-backfill` (popup or dev cmd)
   writes files.

### Claude / ChatGPT — fetch-intercept path

Both providers share `orchestrator.ts`, parameterised on `{ provider,
interceptSource, titleStripRe }`.

```
claude.ai / chatgpt.com tab
  ├─ intercept{,-chatgpt}.js (MAIN world, run_at: document_start)
  │     monkey-patches window.fetch
  │     on a 200 GET that matches the provider regex:
  │       /api/organizations/<org>/chat_conversations/<c>            (Claude)
  │       /backend-api/conversation/<c>                              (ChatGPT)
  │     clone() → json() → window.postMessage({ source, type, conversationId, body })
  │
  └─ content.js (ISOLATED world, run_at: document_idle)
        startOrchestrator(parser, { provider, interceptSource, titleStripRe })
          ↓ window.addEventListener('message', …)
        handleConversation(msg)
          ├─ ⛔ if (!isBackfillInFlight()) return   ← gate
          ├─ parser.parseConversation(msg.body)              → ConversationData
          │     ClaudeParser  — chat_messages[] flat
          │     ChatGPTParser — current_node → parent walk → linear; drops
          │                     hidden / weight=0 / system / tool / non-`recipient:all`
          ├─ inRange = messages where createdAt ∈ [range.start, range.end)
          ├─ messagesToMarkdown(inRange, title, url, range.label, provider)
          ├─ SHA-256 dedup keyed by conversationId (cross-tab via storage)
          ├─ folderDate = YYYY-MM-DD of max(inRange.createdAt)
          └─ chrome.runtime.sendMessage({ type:'DOWNLOAD_REQUEST', filename, content })
                  │
                  ▼
        background.js (service worker)
          ├─ verify sender.tab.url is in host_permissions
          ├─ chrome.downloads.download({ url: data:text/markdown;…, filename })
          └─ chrome.storage.local.set({ lastDownload: { filename, at } })
                  │
                  ▼
        ~/Downloads/weaver-octopus/<chat-date>/[<provider>] <title>-<convId8>.md
```

### Gemini — DOM-scrape path

Gemini's DOM has no per-turn timestamps, so date attribution comes from
the multi-day prompt index scraped on `myactivity.google.com`.

```
gemini.google.com tab
  └─ content.js (ISOLATED, run_at: document_idle)
        startGeminiOrchestrator()
          ├─ MutationObserver on body  → debounce 1.5s → runExport()
          ├─ history.pushState/replaceState patched → reset state on chat switch
          └─ runExport()
                ├─ ⛔ if (!isBackfillInFlight()) return   ← same gate
                ├─ scrapeTurns(document)               — strips "你说" / "Gemini 说"
                │                                       UI wrappers + drops trailing
                │                                       ghost turns (userText empty)
                ├─ if last turn streaming → defer
                ├─ filter = loadFilter(); range = computeRange(filter, now)
                ├─ activity = chrome.storage.local.get('geminiActivity')
                │     missing or no in-range days → REFRESH_ACTIVITY → wait → retry
                ├─ inRange = pickPromptsInRange(activity, range)   {prompts, dates}
                ├─ slice = computeTodaySlice(turns, inRange.prompts)
                │           — claim-once tail walk (newest-first); first non-match
                │             stops the walk. Empty slice → skip:date.
                ├─ folderDate = deriveChatDate(slice, inRange.prompts, inRange.dates)
                ├─ in-tab fingerprint dedup + cross-tab SHA-256 ('gemini:<convId>')
                └─ DOWNLOAD_REQUEST → background → file written

myactivity.google.com/product/gemini tab
  └─ myactivity.js (ISOLATED, run_at: document_idle)
        MutationObserver → debounce 1.2s → collectActivityByDate(document, now)
          → chrome.storage.local.set({ geminiActivity: { scrapedAt, days[] } })

        Storage shape:
          {
            scrapedAt: "2026-05-06T10:20:02.898Z",
            days: [
              { date: "2026-05-06", prompts: [...] },
              { date: "2026-05-05", prompts: [...] },
              ...
            ]
          }
```

### Backfill runner — the only thing that downloads

```
popup / dev-trigger
  └─ START_BACKFILL → background
        ├─ ensureProviderTab(p)  — root URL > active > lowest tab.id (deterministic)
        ├─ tab-group all provider tabs under "Weaver Octopus Backfill"
        └─ for each provider:
             chrome.tabs.sendMessage(tabId, { type:'BACKFILL_RUN', ... })
               │
               ▼
        content.js  installBackfillListener(provider)
          ├─ setBackfillInFlight(true)        ← opens the gate
          └─ runBackfill(adapter, opts)
                ├─ adapter.enumerate() → BackfillLink[]   (sidebar scrape)
                ├─ for each link:
                │     adapter.navigate(link)              (click or pushState)
                │     waitForCaptureSignal(perChatTimeoutMs):
                │        - listen for CAPTURE_DECISION CustomEvent (fast path)
                │        - or poll lastDownload (slow fallback)
                │     reportPatch({ done|skipped|failed: 1, appendLog: [...] })
                │     pace minIntervalMs..maxIntervalMs (default 1-2s)
                │     5-consecutive-skipped:date → early-stop
                └─ setBackfillInFlight(false)
```

mutateProgress (background) read-modify-writes `backfillProgress` storage,
serialised via a promise chain so two near-simultaneous patches don't
clobber each other (regression hit in production: see commit 6bbe612).

## Key design decisions

### Zero extra requests for capture
Both Claude and ChatGPT capture happens by hooking `window.fetch` in the
MAIN world rather than calling the conversation API ourselves. The
abandoned alternative ("fetch-mode replay") was tried and removed — see
commit 6bbe612 for the post-mortem. Replaying same-origin fetches with
captured `Authorization: Bearer` and `anthropic-*` / sentinel headers
returns 200 but with permission-stripped bodies (Claude → 403; ChatGPT
list endpoint → empty `items`). Observing what the SPA already does is
the only auth-free path.

### Backfill-only model
The orchestrator's gate (`isBackfillInFlight()`) drops every observed
event when no backfill is running on this tab. Earlier iterations
exposed a popup toggle that let the user opt INTO live capture; that
toggle was removed (commit b1d55b8) — the dual-path gate, the storage
key, and the popup UI weren't pulling weight against actual usage.

### Date filter applies to all providers
The popup's date filter (today / yesterday / last 7 days / this week /
custom range) is a single `dateFilter` storage key consumed by both
the Claude/ChatGPT path (`m.createdAt ∈ [range.start, range.end)`) and
the Gemini path (`pickPromptsInRange(activity, range) → flatten → match`).

### Folder = chat's content date, not capture date
A `yesterday` filter writes to `~/Downloads/.../<yesterday>/`. Computed
as `max(createdAt)` over in-range messages (Claude/ChatGPT) or via
`deriveChatDate` over matched myactivity prompts (Gemini), with a
fall-back to today only when the slice carries no usable timestamps.

### Per-conversation hash dedup
`Map<conversationId, sha256>` keyed by the conversation UUID. Cross-tab
via `chrome.storage.local.convHashes`; the orchestrator mirrors external
writes (popup Reset / another tab) into its in-memory map but does NOT
auto-redownload — the user has to revisit the chat.

### Filename collision
`[<provider>] <sanitized-title>-<convId-first-8>.md`. Two different
chats with the same title on the same day still don't collide.

### Data URL for download
`chrome.downloads.download` is invoked with a `data:text/markdown;…`
URL. Blob URLs created inside an MV3 service worker silently fail on
some Chrome versions; data URLs are universally supported.

### Serialised progress patches
`mutateProgress` (background) read-modify-writes `backfillProgress`
storage. Two near-simultaneous patches with the old "last write wins"
RMW would clobber each other — symptom in production was `total: 0`
appearing mid-run. Now serialised via a promise chain.

### Extension-context-invalidated handling
When the extension is reloaded but the tab is not refreshed,
`chrome.runtime.sendMessage` throws "Extension context invalidated". The
orchestrator detects this string, logs one `console.warn` asking the
user to refresh, and silently ignores all subsequent events.

### Storage hygiene on install
`chrome.runtime.onInstalled` removes legacy keys from previous
incarnations: `claudeApiHeaders` / `claudeCaptureMode` / `claudeOrgId`
(fetch-mode), `todayGemini` (single-day index), `liveCaptureEnabled`
(removed popup toggle).

## Types

### `src/types/index.ts`

```ts
type Provider = 'claude' | 'gemini' | 'chatgpt'

interface ChatMessage {
  id: string           // provider's message uuid
  role: 'user' | 'assistant'
  content: string      // text from API content blocks (joined with \n\n)
  createdAt: number    // ms since epoch
}

interface GeminiActivityIndex {
  scrapedAt: string                  // ISO timestamp of last scrape
  days: Array<{
    date: string                     // YYYY-MM-DD local
    prompts: string[]                // newest-first within a day
  }>
}

type ContentToBackgroundMessage =
  | { type: 'DOWNLOAD_REQUEST'; filename: string; content: string }
  | { type: 'BACKFILL_PROGRESS'; provider: Provider; patch: BackfillProviderProgressPatch }
  | { type: 'REFRESH_ACTIVITY' }
  // ...

interface LastDownload {
  filename: string
  at: number
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

## Watched API endpoints (may break on backend changes)

| Provider | Match | Notes |
|----------|-------|-------|
| Claude   | `/api/organizations/<uuid>/chat_conversations/<uuid>` | GET only; must contain `chat_messages` array |
| ChatGPT  | `/backend-api/conversation/<uuid>`                    | GET only; must contain `mapping` + `current_node` |

Regexes live in `src/content/main-world/intercept.ts` and
`src/content/main-world/intercept-chatgpt.ts`. Sub-paths under the
ChatGPT conversation URL (`/stream_status`, `/textdocs`) are filtered
out — only the bare `/conversation/<uuid>` carries the mapping.

## Markdown output format

```markdown
# Chat Title

**Provider**: claude
**Captured**: 2026-04-29
**Range**: 2026-04-29
**URL**: https://claude.ai/chat/abc123

---

## User

User's message text

---

## Assistant

Assistant's response text

---
```

File path: `~/Downloads/weaver-octopus/<chat-content-date>/[<provider>] <sanitized-title>-<convId8>.md`

Filename sanitization: characters `/ \ : * ? " < > |` are replaced with `-`,
truncated to 200 chars; conversation id's first 8 hex chars are appended
before `.md`. **Folder date is the chat's content date** (newest in-range
message), not the capture date.

## Debugging

### Check intercept is installed
On `claude.ai`, DevTools → Console:
```js
__weaverFetchPatched           // → true
```
On `chatgpt.com`:
```js
__weaverChatGPTFetchPatched    // → true
```

### Check orchestrator is running
Look for `[weaver:orch:claude] started` (or `:chatgpt` / `[weaver:gemini]`)
in the page console after refresh — printed at content-script init.

### Trigger a capture
Backfill is the only way: open the popup → click 「批量回填」, or
`dev:trigger '{"action":"start-backfill","providers":["claude"]}'`.
Each successful chat produces one
`[weaver:orch:<p>]#N sending DOWNLOAD_REQUEST { filename, bytes, ... }`
followed by `download acked by background`.

### Background service worker
`chrome://extensions` → click **Service Worker** link on the extension
card → opens DevTools for the background context. Look for
`[weaver:bg]#N DOWNLOAD_REQUEST`, `[weaver:bg]#N ack ok`, etc.

### Inspect downloaded files
`~/Downloads/weaver-octopus/` — subdirectories named by date (`YYYY-MM-DD`).

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `__weaverFetchPatched` / `__weaverChatGPTFetchPatched` undefined | intercept script not loaded in MAIN world | Verify `manifest.json` content_scripts entry has `world: "MAIN"`, `run_at: "document_start"` |
| `[weaver:orch:<provider>] started` missing | content.js not injected | Confirm host matches `manifest.json` content_scripts entry |
| Backfill runs but writes nothing | Date filter too narrow / sidebar entries genuinely out-of-range | Check `dump-storage` for `dateFilter`; check the per-chat `recentLog` reasons in `backfillProgress.perProvider.<p>.recentLog` |
| `skip: no backfill in flight` on every observed fetch | Expected — backfill-only model, not a bug | If you want a chat captured: open the popup and click 「批量回填」 |
| ChatGPT API URL changed | OpenAI moved the endpoint | Update regex in `src/content/main-world/intercept-chatgpt.ts` |
| Claude API URL changed | Anthropic moved the endpoint | Update regex in `src/content/main-world/intercept.ts` |
| Gemini sidebar selectors changed | Google A/B test or redesign | `dev:trigger '{"action":"snapshot-dom","target":"gemini"}'` to see what selectors hit |
| `geminiActivity.days[]` empty | myactivity tab hasn't hydrated, or header regex doesn't match new format | `dev:trigger '{"action":"inspect-myactivity"}'` shows DOM diagnostics + which header candidates exist but didn't parse |
| `Extension context invalidated` warning | Reloaded extension without refreshing tab | Refresh the affected tab (or wait for auto-reload to do it) |
| Empty markdown body | API content block types changed | Check `extractText` / parser for the affected provider |
| Files overwriting each other | Two chats hash-collide on title+id8 | Increase id suffix length in the orchestrator |
| `total: 0` mid-backfill | Pre-fix race in `mutateProgress` | Should be impossible — patches are now serialised. If seen again, check for a regression in the promise chain. |

## Adding support for another provider

For a fetch-intercept provider (the simpler path — works when the SPA
fetches a JSON conversation read endpoint per chat):

1. **Parser**: `src/content/providers/<name>.ts` implementing `ProviderParser`. Mirror `claude.ts` (flat message array) or `chatgpt.ts` (graph walk via `current_node` → `parent`). Drop hidden / system / tool nodes; map message timestamps → ms-since-epoch.
2. **Intercept**: `src/content/main-world/intercept-<name>.ts` mirroring `intercept-chatgpt.ts`. Match the GET on the bare conversation URL (regex), clone the response, post to ISOLATED with a unique `source` sentinel.
3. **Backfill adapter**: `src/content/backfill/<name>.ts` mirroring `backfill/claude.ts`. Sidebar selectors + click navigation + uuid extraction.
4. **Wire into `content/index.ts`**: branch on `location.hostname`, call `startOrchestrator(parser, { provider, interceptSource, titleStripRe })`, then `installBackfillListener('<name>')`.
5. **Manifest**: add `https://<host>/*` to `host_permissions`; add two `content_scripts` entries (one MAIN-world for the intercept, one for content.js).
6. **vite.config.ts**: new `intercept-<name>` entry pointing at the MAIN-world file.
7. **Provider type**: add `'<name>'` to the `Provider` union in `src/types/index.ts`. Update `PROVIDER_URLS`, `providerUrlPattern`, `providerRootUrls` in `background/index.ts`. Update the `start-backfill` provider validator.
8. **Popup**: add a `<input id="provider-<name>">` checkbox + the `chatgptCheck` mirror in `popup/index.ts`.
9. **Tests**: new `providers/<name>.test.ts` covering parser shape + edge cases. Existing parser tests are good templates.

For a DOM-scrape provider (no JSON conversation endpoint, or the
endpoint doesn't carry timestamps): mirror `gemini-orchestrator.ts`
instead of step 2 — separate code path, different gate semantics. Also
need a per-day index source (something like myactivity for that
provider) if you want date filtering.
