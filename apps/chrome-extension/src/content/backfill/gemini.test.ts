// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectGeminiChatLinks, normalizeAppHref } from './gemini.js';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('normalizeAppHref', () => {
  it('extracts the id from a relative /app/<id> path', () => {
    expect(normalizeAppHref('/app/c_abc123')).toBe('/app/c_abc123');
  });

  it('extracts the id from an absolute URL with query/fragment', () => {
    expect(normalizeAppHref('https://gemini.google.com/app/c_abc123?ref=foo#bar')).toBe(
      '/app/c_abc123',
    );
  });

  it('returns null for the welcome page (no id)', () => {
    expect(normalizeAppHref('/app')).toBe(null);
    expect(normalizeAppHref('/app/')).toBe(null);
  });

  it('rejects the literal "new" id', () => {
    expect(normalizeAppHref('/app/new')).toBe(null);
  });

  it('handles /u/0/app/<id> personalised URLs', () => {
    expect(normalizeAppHref('/u/0/app/c_xyz')).toBe('/app/c_xyz');
  });

  it('returns null for malformed inputs', () => {
    expect(normalizeAppHref(null)).toBe(null);
    expect(normalizeAppHref('')).toBe(null);
    expect(normalizeAppHref('garbage')).toBe(null);
  });
});

describe('collectGeminiChatLinks', () => {
  it('finds anchors whose href contains /app/<id>', () => {
    setBody(`
      <a href="/app/c_aaa">First</a>
      <a href="/app/c_bbb">Second</a>
      <a href="/projects/x">unrelated</a>
    `);
    const links = collectGeminiChatLinks(document);
    expect(links).toHaveLength(2);
    expect(links[0]!.href).toBe('/app/c_aaa');
    expect(links[0]!.title).toBe('First');
  });

  it('deduplicates the same chat that appears via different selectors', () => {
    setBody(`
      <a href="/app/c_xyz" data-test-id="conversation-x">A</a>
      <a href="/app/c_xyz?ref=2">B duplicate</a>
    `);
    const links = collectGeminiChatLinks(document);
    expect(links).toHaveLength(1);
  });

  it('skips the welcome page anchor', () => {
    setBody(`
      <a href="/app">welcome</a>
      <a href="/app/c_real">real</a>
    `);
    const links = collectGeminiChatLinks(document);
    expect(links).toHaveLength(1);
    expect(links[0]!.title).toBe('real');
  });

  it('falls back to aria-label when the anchor has no inner text', () => {
    setBody(`<a href="/app/c_iconic" aria-label="Iconic chat"></a>`);
    const links = collectGeminiChatLinks(document);
    expect(links[0]!.title).toBe('Iconic chat');
  });

  it('returns [] when no conversation anchors are present', () => {
    setBody('<div>nothing</div>');
    expect(collectGeminiChatLinks(document)).toEqual([]);
  });
});
