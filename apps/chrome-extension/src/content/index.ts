import type { Provider } from '../types/index.js';

function detectProvider(): Provider | null {
  const { hostname } = location;
  if (hostname === 'gemini.google.com') return 'gemini';
  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt';
  if (hostname === 'claude.ai') return 'claude';
  return null;
}

const provider = detectProvider();

if (provider) {
  console.log(`[weaver-octopus] Content script active on provider: ${provider}`);
  // Provider-specific capture logic will be implemented here.
}
