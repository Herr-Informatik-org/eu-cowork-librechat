import express, { Router } from 'express';
import request from 'supertest';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createOfficeRouter } from '~/office/router';
import { createMailAssistantRouter, createMailAssistantCallbackRouter } from './router';
import { defaultMailSettings } from './schedule';
import type { MailAssistantRuntime } from './runtime';
const owner = '64b123456789012345678901';
function setup(
  runtime: MailAssistantRuntime | null = null,
  identity: { id?: string; tenantId?: string } = { id: owner },
) {
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
          (req as ServerRequest).user = identity as IUser;
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
    expect(
      (await request(app).get('/api/agents/office/mail-assistant/results/result-1/content')).status,
    ).toBe(401);
  });
  it('uses authenticated ownership for bounded result content and disables response caching', async () => {
    const content = jest.fn(async () => ({
      resultId: 'result-1',
      mailbox: 'person@example.invalid',
      message: {
        subject: 'Test',
        sender: 'sender@example.invalid',
        receivedAt: '2026-10-26T08:00:00Z',
        body: 'Privater Inhalt',
        bodyTruncated: false,
      },
    }));
    const runtime: MailAssistantRuntime = {
      engine: {
        content,
        status: jest.fn(),
        settings: jest.fn(),
        run: jest.fn(),
        pause: jest.fn(),
        disconnect: jest.fn(),
        priority: jest.fn(),
        tick: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
      },
      oauth: {
        start: jest.fn(),
        complete: jest.fn(),
        status: jest.fn(),
        disconnect: jest.fn(),
        token: jest.fn(),
      },
      adapter: {
        authorize: jest.fn(),
        availability: jest.fn(),
        connection: jest.fn(),
        graph: jest.fn(),
        analyze: jest.fn(),
        audit: jest.fn(),
      },
    };
    const app = setup(runtime);
    const response = await request(app)
      .get(
        '/api/agents/office/mail-assistant/results/result-1/content?owner=other-user&messageId=external',
      )
      .set('authorization', 'Bearer fixture');
    expect(response.status).toBe(200);
    expect(content).toHaveBeenCalledWith(owner, 'result-1');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.message.body).toBe('Privater Inhalt');
    content.mockClear();
    for (const id of ['invalid%20id', 'a'.repeat(129)]) {
      const invalid = await request(app)
        .get(`/api/agents/office/mail-assistant/results/${id}/content`)
        .set('authorization', 'Bearer fixture');
      expect(invalid.status).toBe(400);
    }
    expect(content).not.toHaveBeenCalled();
    for (const identity of [{}, { id: owner, tenantId: 'other-tenant' }]) {
      const unauthorized = await request(setup(runtime, identity))
        .get('/api/agents/office/mail-assistant/results/result-1/content')
        .set('authorization', 'Bearer fixture');
      expect(unauthorized.status).toBe(identity.id ? 403 : 401);
    }
    expect(content).not.toHaveBeenCalled();
    content.mockRejectedValueOnce(new Error('provider-private-token'));
    const failure = await request(app)
      .get('/api/agents/office/mail-assistant/results/result-1/content')
      .set('authorization', 'Bearer fixture');
    expect(failure.status).toBe(400);
    expect(failure.text).not.toContain('provider-private-token');
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
