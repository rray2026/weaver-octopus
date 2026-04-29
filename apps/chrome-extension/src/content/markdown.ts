import type { ChatMessage } from '../types/index.js';

export function todayDateString(): string {
  return new Date().toLocaleDateString('en-CA');
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .trim()
    .slice(0, 200) || 'untitled';
}

export function messagesToMarkdown(
  messages: ChatMessage[],
  title: string,
  url: string,
  rangeLabel?: string,
): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `**Provider**: claude`,
    `**Captured**: ${todayDateString()}`,
  ];
  if (rangeLabel) lines.push(`**Range**: ${rangeLabel}`);
  lines.push(`**URL**: ${url}`, '', '---', '');

  for (const msg of messages) {
    const heading = msg.role === 'user' ? '## User' : '## Assistant';
    lines.push(heading, '', msg.content.trim(), '', '---', '');
  }

  return lines.join('\n');
}
