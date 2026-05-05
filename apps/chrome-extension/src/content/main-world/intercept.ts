export {}; // Marks the file as a module so tests can side-effect-import it.

// Runs in the page's MAIN world (see manifest.json content_scripts entry).
// Hooks window.fetch to passively observe Claude's own conversation requests
// and forwards the JSON body to the isolated content script via postMessage.
//
// Important: this script must NOT issue extra requests, modify responses, or
// throw — its sole purpose is to clone successful conversation fetches.

const CONVERSATION_URL_RE =
  /\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/([0-9a-f-]{36})(?:[/?]|$)/;

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
