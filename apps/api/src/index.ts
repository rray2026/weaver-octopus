import { logger, optionalEnv } from '@weaver-octopus/utils';
import { createApp } from './app.js';

const port = parseInt(optionalEnv('PORT', '3000'), 10);

const app = createApp();

app.listen(port, () => {
  logger.info('API server started', { port });
});
