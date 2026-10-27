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
    for (const path of [
      '/connect',
      '/run',
      '/pause',
      '/move-jobs',
      '/followup/commit',
      '/results/result-1/followup/prepare',
      '/results/result-1/draft-request',
      '/results/result-1/chat',
    ])
      expect((await request(app).post(`/api/agents/office/mail-assistant${path}`)).status).toBe(
        401,
      );
    expect((await request(app).get('/api/agents/office/mail-assistant/move-jobs')).status).toBe(
      401,
    );
    expect(
      (await request(app).get('/api/agents/office/mail-assistant/results/result-1/content')).status,
    ).toBe(401);
  });
  it('requires authentication for inbox and correspondence pages', async () => {
    const app = setup();
    for (const path of ['/inbox', '/results/' + 'a'.repeat(64) + '/correspondence']) {
      expect((await request(app).get('/api/agents/office/mail-assistant' + path)).status).toBe(401);
    }
  });
  it('binds inbox pages and chat to the authenticated owner and rejects owner overrides', async () => {
    const inbox = jest.fn(async () => ({ results: [], complete: true }));
    const correspondence = jest.fn(async () => ({ results: [], complete: true }));
    const chat = jest.fn(async () => ({ answer: 'Antwort' }));
    const app = setup({
      inbox: { inbox, correspondence },
      chat,
    } as unknown as MailAssistantRuntime);
    const path = '/api/agents/office/mail-assistant';
    const id = 'a'.repeat(64);
    expect(
      (
        await request(app)
          .get(path + '/inbox')
          .set('Authorization', 'Bearer fixture')
      ).status,
    ).toBe(200);
    expect(inbox).toHaveBeenCalledWith(owner, undefined);
    expect(
      (
        await request(app)
          .get(path + '/inbox?owner=foreign')
          .set('Authorization', 'Bearer fixture')
      ).status,
    ).toBe(400);
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(app)
          .get(path + '/results/' + id + '/correspondence?search=Thema')
          .set('Authorization', 'Bearer fixture')
      ).status,
    ).toBe(200);
    expect(correspondence).toHaveBeenCalledWith(owner, id, { search: 'Thema' });
    expect(
      (
        await request(app)
          .post(path + '/results/' + id + '/chat')
          .set('Authorization', 'Bearer fixture')
          .send({ message: 'Frage' })
      ).status,
    ).toBe(200);
    expect(chat).toHaveBeenCalledWith(owner, id, { message: 'Frage' });
  });
  it('binds content, folder choices and explicit mutations to the authenticated owner', async () => {
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
        results: jest.fn(),
        folders: jest.fn(),
        move: jest.fn(),
        moveJobs: jest.fn(),
        enqueueMove: jest.fn(),
        editDraft: jest.fn(),
        requestDraft: jest.fn(),
        attachments: jest.fn(),
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
      followup: {
        settings: jest.fn(),
        saveSettings: jest.fn(),
        projects: jest.fn(),
        prepare: jest.fn(),
        commit: jest.fn(),
        clearPreviews: jest.fn(),
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
    const revision = 'a'.repeat(64);
    await request(app)
      .get('/api/agents/office/mail-assistant/folders?parentId=own-folder')
      .set('authorization', 'Bearer fixture')
      .expect(200);
    expect(runtime.engine.folders).toHaveBeenCalledWith(owner, 'own-folder');
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/move')
      .set('authorization', 'Bearer fixture')
      .send({ folderId: 'own-folder', revision })
      .expect(200);
    expect(runtime.engine.move).toHaveBeenCalledWith(owner, 'result-1', 'own-folder', revision);
    const moveRequest = {
      requestId: '00000000-0000-4000-8000-000000000001',
      folderId: 'own-folder',
      items: [{ id: 'a'.repeat(64), revision }],
    };
    jest.mocked(runtime.engine.enqueueMove).mockResolvedValue({
      id: moveRequest.requestId,
      status: 'queued',
      total: 1,
      completed: 0,
      failed: 0,
      folderName: '',
      items: [],
      createdAt: '2026-10-27T08:00:00Z',
      updatedAt: '2026-10-27T08:00:00Z',
    });
    const accepted = await request(app)
      .post('/api/agents/office/mail-assistant/move-jobs?owner=other-user')
      .set('authorization', 'Bearer fixture')
      .send(moveRequest)
      .expect(202);
    expect(accepted.body.job.status).toBe('queued');
    expect(runtime.engine.enqueueMove).toHaveBeenCalledWith(owner, moveRequest);
    await request(app)
      .get('/api/agents/office/mail-assistant/move-jobs?owner=other-user')
      .set('authorization', 'Bearer fixture')
      .expect(200);
    expect(runtime.engine.moveJobs).toHaveBeenCalledWith(owner);
    await request(app)
      .put('/api/agents/office/mail-assistant/results/result-1/draft')
      .set('authorization', 'Bearer fixture')
      .send({ body: 'Explicit edited reply', revision })
      .expect(204);
    expect(runtime.engine.editDraft).toHaveBeenCalledWith(
      owner,
      'result-1',
      'Explicit edited reply',
      revision,
    );
    const draftRequest = {
      revision,
      instructions: 'Termin am Freitag bestätigen.',
      requestId: '00000000-0000-4000-8000-000000000002',
    };
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/draft-request')
      .set('authorization', 'Bearer fixture')
      .send(draftRequest)
      .expect(200);
    expect(runtime.engine.requestDraft).toHaveBeenCalledWith(owner, 'result-1', draftRequest);
    await request(app)
      .get('/api/agents/office/mail-assistant/results/result-1/attachments?owner=someone-else')
      .set('authorization', 'Bearer fixture')
      .expect(200);
    expect(runtime.engine.attachments).toHaveBeenCalledWith(owner, 'result-1');
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/draft-request')
      .set('authorization', 'Bearer fixture')
      .send({ ...draftRequest, send: true })
      .expect(400);
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/draft-request')
      .set('authorization', 'Bearer fixture')
      .send({ ...draftRequest, instructions: 'x'.repeat(4001) })
      .expect(400);
    expect(runtime.engine.requestDraft).toHaveBeenCalledTimes(1);
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/followup/prepare')
      .set('authorization', 'Bearer fixture')
      .send({ revision })
      .expect(200);
    expect(runtime.followup!.prepare).toHaveBeenCalledWith(owner, 'result-1', { revision });
    const commit = { token: '00000000-0000-4000-8000-000000000003', taskId: 99 };
    await request(app)
      .post('/api/agents/office/mail-assistant/followup/commit')
      .set('authorization', 'Bearer fixture')
      .send(commit)
      .expect(200);
    expect(runtime.followup!.commit).toHaveBeenCalledWith(owner, commit);
    for (const extra of [
      { ownerId: 'other' },
      { tool: 'call_model_method' },
      { model: 'mail.mail' },
      { values: { body: 'injected' } },
    ]) {
      await request(app)
        .post('/api/agents/office/mail-assistant/followup/commit')
        .set('authorization', 'Bearer fixture')
        .send({ ...commit, ...extra })
        .expect(400);
    }
    expect(runtime.followup!.commit).toHaveBeenCalledTimes(1);
    for (const extra of [
      { ownerId: 'someone-else' },
      { messageId: 'arbitrary-graph-id' },
      { send: true },
    ]) {
      await request(app)
        .post('/api/agents/office/mail-assistant/results/result-1/move')
        .set('authorization', 'Bearer fixture')
        .send({ folderId: 'own-folder', revision, ...extra })
        .expect(400);
    }
    expect(runtime.engine.move).toHaveBeenCalledTimes(1);
    const base = '/api/agents/office/mail-assistant';
    const followup = runtime.followup!;
    const target = { profile: 'odoo-technik', mode: 'todo' };
    await request(app)
      .get(`${base}/followup/settings`)
      .set('authorization', 'Bearer fixture')
      .expect(200);
    await request(app)
      .get(`${base}/followup/projects?profile=odoo-technik&search=GL`)
      .set('authorization', 'Bearer fixture')
      .expect(200);
    await request(app)
      .put(`${base}/followup/settings`)
      .set('authorization', 'Bearer fixture')
      .send(target)
      .expect(200);
    for (const path of ['/status', '/availability']) {
      const result = await request(app)
        .get(`${base}${path}`)
        .set('authorization', 'Bearer fixture')
        .expect(200);
      expect(result.body.odooAvailable).toBe(true);
    }
    delete runtime.followup;
    for (const path of ['/followup/settings', '/followup/projects?profile=odoo-technik&search=GL'])
      await request(app).get(`${base}${path}`).set('authorization', 'Bearer fixture').expect(400);
    await request(app)
      .put(`${base}/followup/settings`)
      .set('authorization', 'Bearer fixture')
      .send(target)
      .expect(400);
    await request(app)
      .post(`${base}/results/result-1/followup/prepare`)
      .set('authorization', 'Bearer fixture')
      .send({ revision })
      .expect(400);
    await request(app)
      .post(`${base}/followup/commit`)
      .set('authorization', 'Bearer fixture')
      .send(commit)
      .expect(400);
    for (const action of ['settings', 'saveSettings', 'projects', 'prepare', 'commit'] as const)
      expect(followup[action]).toHaveBeenCalledTimes(1);
    for (const path of ['/status', '/availability']) {
      const result = await request(app)
        .get(`${base}${path}`)
        .set('authorization', 'Bearer fixture')
        .expect(200);
      expect(result.body.odooAvailable).toBe(false);
    }
    await request(app)
      .post(`${base}/results/result-1/draft-request`)
      .set('authorization', 'Bearer fixture')
      .send(draftRequest)
      .expect(200);
    expect(runtime.engine.requestDraft).toHaveBeenCalledTimes(2);
  });
  it('returns complete safe defaults while the feature is off', async () => {
    const result = await request(setup())
      .get('/api/agents/office/mail-assistant/status')
      .set('authorization', 'Bearer fixture');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      available: false,
      odooAvailable: false,
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
