// ChatGPT conversation parser.
//
// Input: the JSON body of a `GET /backend-api/conversation/<uuid>` response
// (intercepted from the SPA's own fetch — see intercept-chatgpt.ts).
//
// The body carries the conversation as a TREE: `mapping[id] = { id, message,
// parent, children }`. Branching happens whenever the user edits a prompt or
// regenerates an assistant turn. The user-visible flow is exactly the path
// from the leaf (`current_node`) back to the root through `parent` pointers.
// We linearise that path, drop hidden / system / tool nodes, and surface
// only user + assistant turns.
//
// Filtering rules — every one of these has been seen in real responses:
//
//   - `message === null`             → root sentinel; no content.
//   - `metadata.is_visually_hidden_from_conversation === true`
//                                    → seed / system context the SPA never
//                                      shows (e.g. "rebase_developer_message").
//   - `weight === 0`                 → same idea, a backup signal.
//   - `author.role` ∈ {'system', 'tool'}
//                                    → not part of the visible chat.
//   - `recipient !== 'all'`          → assistant→tool internal handoffs.
//
// `content.parts` is usually `string[]` for `content_type: 'text'`. For
// `multimodal_text` and similar variants `parts` may contain non-string
// objects (e.g. `image_asset_pointer`). We extract only the strings and
// emit a `[image]` placeholder for the rest so the markdown stays readable
// without dropping turns entirely.
//
// `message.create_time` is unix seconds with decimal precision; multiply by
// 1000 for ChatMessage.createdAt (ms since epoch). Hidden seeds have
// `create_time === null`; we already skip those before this point.

import type { ChatMessage } from '../../types/index.js';
import type { ConversationData, ProviderParser } from './types.js';

interface ApiAuthor {
  role: 'system' | 'user' | 'assistant' | 'tool';
  name?: string | null;
  metadata?: Record<string, unknown>;
}

interface ApiContent {
  content_type: string;
  parts?: unknown[];
}

interface ApiMessage {
  id: string;
  author: ApiAuthor;
  create_time: number | null;
  content: ApiContent;
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
  metadata?: Record<string, unknown>;
  recipient?: string;
}

interface ApiMappingNode {
  id: string;
  message: ApiMessage | null;
  parent: string | null;
  children: string[];
}

interface ApiConversation {
  title?: string | null;
  current_node?: string | null;
  mapping?: Record<string, ApiMappingNode>;
}

export class ChatGPTParser implements ProviderParser {
  parseConversation(
    body: unknown,
    url: string,
    fallbackTitle: string,
  ): ConversationData | null {
    if (!isApiConversation(body)) return null;
    const mapping = body.mapping;
    if (!mapping || typeof mapping !== 'object') return null;
    const currentNodeId = body.current_node;
    if (!currentNodeId || typeof currentNodeId !== 'string') return null;

    // Walk from current_node back to root via `parent`, collect ids,
    // reverse so we end up with oldest → newest in display order.
    const path: string[] = [];
    const visited = new Set<string>();
    let cursor: string | null = currentNodeId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      path.push(cursor);
      const cur: ApiMappingNode | undefined = mapping[cursor];
      cursor = cur?.parent ?? null;
    }
    path.reverse();

    const messages: ChatMessage[] = [];
    for (const id of path) {
      const node = mapping[id];
      if (!node) continue;
      const m = node.message;
      if (!m) continue;
      if (m.metadata?.['is_visually_hidden_from_conversation'] === true) continue;
      if (typeof m.weight === 'number' && m.weight === 0) continue;
      const role = m.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      // Internal tool handoffs (recipient: 'web', 'browser.search', ...) —
      // these would clutter the markdown without adding visible content.
      if (m.recipient && m.recipient !== 'all') continue;

      const text = extractText(m.content);
      if (!text) continue;

      const createdAt =
        typeof m.create_time === 'number' && Number.isFinite(m.create_time)
          ? Math.round(m.create_time * 1000)
          : 0;

      messages.push({ id: m.id ?? id, role, content: text, createdAt });
    }

    return {
      title: (body.title?.trim() || fallbackTitle || 'Untitled').slice(0, 200),
      url,
      messages,
    };
  }
}

function isApiConversation(body: unknown): body is ApiConversation {
  return (
    typeof body === 'object' &&
    body !== null &&
    'mapping' in body &&
    'current_node' in body
  );
}

function extractText(content: ApiContent): string {
  if (!content || !Array.isArray(content.parts)) return '';
  const out: string[] = [];
  for (const p of content.parts) {
    if (typeof p === 'string') {
      const trimmed = p.trim();
      if (trimmed.length > 0) out.push(trimmed);
    } else if (p && typeof p === 'object') {
      const ct = (p as { content_type?: unknown }).content_type;
      if (typeof ct === 'string' && ct.includes('image')) {
        out.push('[image]');
      } else if (typeof ct === 'string') {
        out.push(`[${ct}]`);
      }
    }
  }
  return out.join('\n\n');
}
