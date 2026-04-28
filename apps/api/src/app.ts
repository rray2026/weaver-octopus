import express from 'express';
import { healthRouter } from './routes/health.js';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/health', healthRouter);

  return app;
}
