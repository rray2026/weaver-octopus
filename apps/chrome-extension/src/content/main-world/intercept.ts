export {}; // Marks the file as a module so tests can side-effect-import it.

// Runs in the page's MAIN world (see manifest.json content_scripts entry).
// Hooks window.fetch to passively observe Claude's own conversation requests
// and forwards the JSON body to the isolated content script via postMessage.
//
// Important: this script must NOT issue extra requests, modify responses, or
// throw — its sole purpose is to clone successful conversation fetches.

const CONVERSATION_URL_RE =
  /\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/([0-9a-f-]{36})(?:[/?]|$)/;
// Capture identity headers from any Claude API call. Required by the
// 'fetch' capture mode — Claude's API rejects requests that don't carry
// these (anthropic-anonymous-id / -client-platform / -device-id / etc) with
// 403 even when cookies are present.
const ANY_API_URL_RE = /\/api\//;
// Only forward "auth-ish" headers — never the request body, content-length,
// or anything else that's specific to the original call.
//   - anthropic-* / x-* / sec-fetch-* (prefix matches)
//   - exactly "authorization" / "accept" / "accept-language"
const HEADER_KEEP_RE =
  /^(?:anthropic-|x-|sec-fetch-|authorization$|accept(?:-language)?$)/i;

const SOURCE = 'weaver-octopus:intercept';
const PATCH_FLAG = '__weaverFetchPatched';
const TAG = '[weaver:intercept]';

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
    // Headers can be captured up-front (no response needed). Capture EARLY
    // so even calls that fail or hang have a chance to populate the cache.
    try {
      maybeCaptureHeaders(args[0], args[1]);
    } catch (err) {
      console.warn(TAG, 'maybeCaptureHeaders threw (swallowed)', err);
    }
    const response = await origFetch(...args);
    try {
      maybeForward(args[0], args[1], response);
    } catch (err) {
      console.warn(TAG, 'maybeForward threw (swallowed)', err);
    }
    return response;
  };
})();

function maybeCaptureHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): void {
  const url = inferUrl(input);
  if (!url || !ANY_API_URL_RE.test(url)) return;
  const headers = extractAuthHeaders(input, init);
  if (!headers || Object.keys(headers).length === 0) return;
  window.postMessage(
    { source: SOURCE, type: 'API_HEADERS', headers },
    location.origin,
  );
}

function maybeForward(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
): void {
  const url = inferUrl(input);
  if (!url) return;

  const match = url.match(CONVERSATION_URL_RE);
  if (!match) return;

  // From here on we're sure the URL is a conversation endpoint, so it's worth
  // logging every decision — this is exactly the path the user wants traced.
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

  console.log(tag, 'matched conversation fetch', { url, conversationId, status: response.status });

  let cloned: Response;
  try {
    cloned = response.clone();
    console.log(tag, 'response.clone() ok, bodyUsed=', cloned.bodyUsed);
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
      const msgs = (body as { chat_messages?: unknown }).chat_messages;
      if (!Array.isArray(msgs)) {
        console.log(tag, 'skip: chat_messages not an array', { kind: typeof msgs });
        return;
      }
      console.log(tag, 'posting to ISOLATED', {
        conversationId,
        messageCount: msgs.length,
        origin: location.origin,
      });
      window.postMessage(
        { source: SOURCE, type: 'CONVERSATION', conversationId, body },
        location.origin,
      );
    })
    .catch((err) => {
      console.error(tag, 'JSON parse failed (clone may already be consumed)', err);
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

function extractAuthHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Record<string, string> | null {
  // Headers can come from RequestInit, from a Request object, or both —
  // RequestInit takes precedence in Fetch semantics. Build a normalised
  // lower-cased map and filter to identity-flavoured names.
  const merged: Record<string, string> = {};
  pushFrom(merged, input);
  if (init?.headers) pushHeaders(merged, init.headers);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (HEADER_KEEP_RE.test(k)) out[k] = v;
  }
  return out;
}

function pushFrom(into: Record<string, string>, input: RequestInfo | URL): void {
  if (typeof input === 'object' && input !== null && 'headers' in input) {
    pushHeaders(into, (input as Request).headers);
  }
}

function pushHeaders(into: Record<string, string>, raw: HeadersInit): void {
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      into[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(raw)) {
    for (const [k, v] of raw) into[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(raw)) into[k.toLowerCase()] = String(v);
  }
}
