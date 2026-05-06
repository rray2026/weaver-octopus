export {}; // module marker

// Runs in the page's MAIN world on chatgpt.com (see manifest.json).
// Hooks window.fetch to passively observe the SPA's own conversation
// reads and forward the JSON body to the isolated content script via
// postMessage.
//
// Why intercept (not direct fetch from our content script):
//  - Cookie-only same-origin GET on `/backend-api/conversations` returns
//    HTTP 200 with `total: 0` (permission-stripped). The endpoints
//    require the `Authorization: Bearer <jwt>` and OpenAI-Sentinel-*
//    headers the SPA attaches programmatically. Trying to replay those
//    leads to the same 403 Cloudflare/sentinel trap we hit on Claude.
//  - Observing what the SPA already does is auth-free. Live-verified
//    (see chatgpt-probe.ts artefacts in git history) — every chat visit
//    triggers exactly one GET, including SPA-internal pushState navs.

const CONVERSATION_URL_RE =
  /\/backend-api\/conversation\/([0-9a-f-]{36})(?:[/?]|$)/;
// Sub-paths of the same conversation id (`/stream_status`, `/textdocs`,
// POST `/init`) are NOT what we want — they don't carry the mapping.
// Only match the bare `/conversation/<uuid>` GET.
const CONVERSATION_BARE_RE =
  /^\/backend-api\/conversation\/[0-9a-f-]{36}(\?.*)?$/;

const SOURCE = 'weaver-octopus:chatgpt-intercept';
const PATCH_FLAG = '__weaverChatGPTFetchPatched';
const TAG = '[weaver:chatgpt-intercept]';

let seq = 0;

(function install(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[PATCH_FLAG]) {
    console.log(TAG, 'already patched, skipping');
    return;
  }
  w[PATCH_FLAG] = true;
  console.log(TAG, 'fetch patch installed');

  const origFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const response = await origFetch(...args);
    try {
      maybeForward(args[0], args[1], response);
    } catch (err) {
      console.warn(TAG, 'maybeForward threw (swallowed)', err);
    }
    return response;
  };
})();

function maybeForward(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
): void {
  const url = inferUrl(input);
  if (!url) return;
  const path = pathOf(url);
  if (!path) return;
  if (!CONVERSATION_BARE_RE.test(path)) return;

  const match = path.match(CONVERSATION_URL_RE);
  if (!match) return;

  const id = ++seq;
  const conversationId = match[1]!;
  const tag = `${TAG}#${id}`;

  if (!response.ok) {
    console.log(tag, 'skip: response not ok', { status: response.status, conversationId });
    return;
  }
  const method = inferMethod(input, init);
  if (method !== 'GET') {
    console.log(tag, 'skip: non-GET', { method, conversationId });
    return;
  }

  console.log(tag, 'matched conversation fetch', { url, conversationId });

  let cloned: Response;
  try {
    cloned = response.clone();
  } catch (err) {
    console.error(tag, 'response.clone() failed', err);
    return;
  }

  cloned
    .json()
    .then((body: unknown) => {
      if (!body || typeof body !== 'object') {
        console.log(tag, 'skip: body not an object', { type: typeof body });
        return;
      }
      const mapping = (body as { mapping?: unknown }).mapping;
      if (!mapping || typeof mapping !== 'object') {
        console.log(tag, 'skip: mapping missing or not an object');
        return;
      }
      const messageCount = Object.keys(mapping as Record<string, unknown>).length;
      console.log(tag, 'posting to ISOLATED', {
        conversationId,
        messageCount,
        origin: location.origin,
      });
      window.postMessage(
        { source: SOURCE, type: 'CONVERSATION', conversationId, body },
        location.origin,
      );
    })
    .catch((err) => {
      console.error(tag, 'JSON parse failed', err);
    });
}

function inferMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init && init.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input) {
    return (input as Request).method.toUpperCase();
  }
  return 'GET';
}

function inferUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return (input as Request).url;
  }
  return null;
}

/** Extracts pathname+search from absolute or relative URLs. */
function pathOf(url: string): string | null {
  try {
    const u = new URL(url, location.origin);
    return u.pathname + (u.search || '');
  } catch {
    return null;
  }
}
