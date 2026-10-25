import express, { Router } from 'express';
import request from 'supertest';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createOfficeRouter } from '~/office/router';
import { createMailAssistantRouter, createMailAssistantCallbackRouter } from './router';
import { defaultMailSettings } from './schedule';
import type { MailAssistantRuntime } from './runtime';
const owner = '64b123456789012345678901';
function setup(runtime: MailAssistantRuntime | null = null) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/agents/office',
    createOfficeRouter({
      authenticate: [
        (req, res, next) => {
          if (req.get('authorization') !== 'Bearer fixture') {
            res.sendStatus(401);
            return;
          }
          (req as ServerRequest).user = { id: owner } as IUser;
          next();
        },
      ],
      configure: (_req, _res, next) => next(),
      chatRouter: Router(),
      imageUpload: [],
      imageRouter: Router(),
      cleanupUpload: async () => {},
      remoteAgentIds: async () => new Set(),
      getFiles: async () => [],
      getConvo: async () => null,
      getConvosByCursor: async () => ({ conversations: [], nextCursor: null }),
      getMessages: async () => [],
      mailAssistantRouter: createMailAssistantRouter(runtime),
      mailAssistantCallbackRouter: createMailAssistantCallbackRouter(runtime),
    }),
  );
  return app;
}
describe('Personal mail HTTP boundary', () => {
  it('requires Cowork auth for status and every initiating operation', async () => {
    const app = setup();
    expect((await request(app).get('/api/agents/office/mail-assistant/status')).status).toBe(401);
    for (const path of ['/connect', '/run', '/pause'])
      expect((await request(app).post(`/api/agents/office/mail-assistant${path}`)).status).toBe(
        401,
      );
  });
  it('returns complete safe defaults while the feature is off', async () => {
    const result = await request(setup())
      .get('/api/agents/office/mail-assistant/status')
      .set('authorization', 'Bearer fixture');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      available: false,
      settings: defaultMailSettings(),
      connection: { connected: false },
      activity: { running: false, pending: 0 },
      results: [],
    });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('allows only the exact one-use callback before authentication and never reflects OAuth values', async () => {
    const result = await request(setup()).get(
      '/api/agents/office/mail-assistant/callback?code=sensitive-code&state=sensitive-state&error=secret',
    );
    expect(result.status).toBe(400);
    expect(result.text).not.toMatch(/sensitive|secret/);
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect((await request(setup()).post('/api/agents/office/mail-assistant/callback')).status).toBe(
      401,
    );
  });
});
