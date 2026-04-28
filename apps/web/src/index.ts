import { logger, optionalEnv } from '@weaver-octopus/utils';
import express from 'express';

const port = parseInt(optionalEnv('PORT', '3001'), 10);
const apiUrl = optionalEnv('API_URL', 'http://localhost:3000');

const app = express();

app.get('/', (_req, res) => {
  res.send(`
    <!doctype html>
    <html>
      <head><title>Weaver Octopus</title></head>
      <body>
        <h1>Weaver Octopus</h1>
        <p>API: <a href="${apiUrl}/health">${apiUrl}/health</a></p>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  logger.info('Web server started', { port, apiUrl });
});
