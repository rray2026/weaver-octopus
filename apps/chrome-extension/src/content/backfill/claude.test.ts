// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectClaudeChatLinks } from './claude.js';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('collectClaudeChatLinks', () => {
  it('finds all anchors whose href matches /chat/<uuid>', () => {
    setBody(`
      <nav>
        <a href="/chat/11111111-1111-1111-1111-111111111111">Chat A</a>
        <a href="/chat/22222222-2222-2222-2222-222222222222">Chat B</a>
        <a href="/projects/abc">unrelated</a>
        <a href="/chat/abc">not-a-uuid</a>
      </nav>
    `);
    const links = collectClaudeChatLinks(document);
    expect(links).toHaveLength(2);
    expect(links[0]!.href).toBe('/chat/11111111-1111-1111-1111-111111111111');
    expect(links[0]!.title).toBe('Chat A');
    expect(links[1]!.title).toBe('Chat B');
  });

  it('strips trailing path segments after the chat id', () => {
    setBody(`<a href="/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/something/extra">X</a>`);
    const links = collectClaudeChatLinks(document);
    expect(links[0]!.href).toBe('/chat/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('dedupes by normalized href when the same chat appears in multiple places', () => {
    setBody(`
      <a href="/chat/11111111-1111-1111-1111-111111111111">first</a>
      <a href="/chat/11111111-1111-1111-1111-111111111111?ref=2">duplicate</a>
    `);
    const links = collectClaudeChatLinks(document);
    expect(links).toHaveLength(1);
    expect(links[0]!.title).toBe('first');
  });

  it('falls back to aria-label when the anchor has no visible text', () => {
    setBody(
      `<a href="/chat/cccccccc-cccc-cccc-cccc-cccccccccccc" aria-label="Aria title"></a>`,
    );
    const links = collectClaudeChatLinks(document);
    expect(links[0]!.title).toBe('Aria title');
  });

  it('preserves DOM order', () => {
    setBody(`
      <a href="/chat/11111111-1111-1111-1111-111111111111">first</a>
      <a href="/chat/22222222-2222-2222-2222-222222222222">second</a>
      <a href="/chat/33333333-3333-3333-3333-333333333333">third</a>
    `);
    const links = collectClaudeChatLinks(document);
    expect(links.map((l) => l.title)).toEqual(['first', 'second', 'third']);
  });

  it('returns [] when no chat anchors are present', () => {
    setBody('<p>welcome page, no sidebar yet</p>');
    expect(collectClaudeChatLinks(document)).toEqual([]);
  });
});
