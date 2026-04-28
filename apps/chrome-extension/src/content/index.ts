import { startOrchestrator } from './orchestrator.js';
import { ClaudeScraper } from './providers/claude.js';

if (location.hostname === 'claude.ai') {
  startOrchestrator(new ClaudeScraper());
}
