import { startOrchestrator } from './orchestrator.js';
import { ClaudeParser } from './providers/claude.js';

// Where this script runs is already gated by the manifest's content_scripts
// matches (claude.ai in production, plus localhost in the e2e test build).
try {
  startOrchestrator(new ClaudeParser());
} catch (err) {
  console.error('[weaver] failed to start orchestrator', err);
}
