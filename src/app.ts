import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { getModel, listModels } from './routes/models.ts';
import { health } from './routes/health.ts';
import {
  cancelResponse,
  createResponse,
  deleteResponse,
  getResponse,
  listActiveRuns,
} from './routes/responses.ts';
import {
  createAccountRoute,
  deleteAccountRoute,
  listAccountsRoute,
  setDefaultAccountRoute,
} from './routes/accounts.ts';

export function createApp() {
  const app = new Hono();

  app.use('*', cors());

  app.use('/v1/*', async (c, next) => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return await next();
    return bearerAuth({ token: apiKey })(c, next);
  });

  app.get('/health', health);

  // OpenAI Chat Completions
  app.post('/v1/chat/completions', chatCompletions);
  app.get('/v1/models', listModels);
  app.get('/v1/models/:id', getModel);

  // OpenAI Responses API (session continuity)
  app.post('/v1/responses', createResponse);
  app.get('/v1/responses/:id', getResponse);
  app.delete('/v1/responses/:id', deleteResponse);
  app.post('/v1/responses/:id/cancel', cancelResponse);
  app.get('/v1/runs/active', listActiveRuns);

  // Multi-account management
  app.get('/v1/accounts', listAccountsRoute);
  app.post('/v1/accounts', createAccountRoute);
  app.post('/v1/accounts/default', setDefaultAccountRoute);
  app.delete('/v1/accounts/:id', deleteAccountRoute);

  return app;
}

export const app = createApp();
