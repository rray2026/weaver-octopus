import { startGeminiOrchestrator } from './gemini-orchestrator.js';
import { startOrchestrator } from './orchestrator.js';
import { ClaudeParser } from './providers/claude.js';

// One content.js bundle is shared between claude.ai and gemini.google.com
// (single Vite entry → single Rollup chunk → no shared-module split, which
// would otherwise break content-script loading). Branch on hostname here.
try {
  const host = location.hostname;
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    startOrchestrator(new ClaudeParser());
  } else if (host === 'gemini.google.com' || host.endsWith('.gemini.google.com')) {
    startGeminiOrchestrator();
  } else {
    console.warn('[weaver] content script loaded on unexpected host', host);
  }
} catch (err) {
  console.error('[weaver] failed to start orchestrator', err);
}
