import express, { Router } from 'express';
import request from 'supertest';
import type { IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createOfficeRouter } from '~/office/router';
import { createMailAssistantRouter, createMailAssistantCallbackRouter } from './router';
import { defaultMailSettings } from './schedule';
import type { MailAssistantRuntime } from './runtime';
import { MailAttachmentScanError } from './scanner';
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
      '/results/result-1/images',
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
  it('binds explicit image loading to the authenticated owner and rejects arbitrary resource selectors', async () => {
    const images = jest.fn(async () => ({
      html: '<p>Preview</p>',
      blockedImages: 0,
      truncated: false,
      warnings: [],
    }));
    const app = setup({ engine: { images } } as unknown as MailAssistantRuntime);
    const path = '/api/agents/office/mail-assistant/results/result-1/images';
    const body = { kind: 'original', revision: 'a'.repeat(64) };
    const response = await request(app)
      .post(path)
      .set('Authorization', 'Bearer fixture')
      .send(body);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(images).toHaveBeenCalledWith(owner, 'result-1', 'original', body.revision);
    for (const invalid of [
      { kind: 'external', revision: body.revision },
      { kind: 'original' },
      { ...body, url: 'https://evil.test' },
      { ...body, owner: 'other' },
      { ...body, attachmentId: 'other' },
    ]) {
      expect(
        (await request(app).post(path).set('Authorization', 'Bearer fixture').send(invalid)).status,
      ).toBe(400);
    }
    expect(images).toHaveBeenCalledTimes(1);
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
        editDraft: jest.fn(async () => ({})),
        rememberRule: jest.fn(),
        requestDraft: jest.fn(),
        attachments: jest.fn(),
        images: jest.fn(),
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
    const rule = { text: 'Bitte bei Mailantworten kurz bleiben.', scope: 'global', revision };
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/rule?owner=other')
      .set('authorization', 'Bearer fixture')
      .send(rule)
      .expect(204);
    expect(runtime.engine.rememberRule).toHaveBeenCalledWith(owner, 'result-1', rule);
    await request(app)
      .post('/api/agents/office/mail-assistant/results/result-1/rule')
      .set('authorization', 'Bearer fixture')
      .send({ ...rule, sender: 'other@example.invalid' })
      .expect(400);
    expect(runtime.engine.rememberRule).toHaveBeenCalledTimes(1);
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
      .expect(200);
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

describe('explicit additional reply HTTP boundary', () => {
  test('forwards only the explicit boolean and never accepts client recipients', async () => {
    const requestDraft = jest.fn(async () => ({ status: 'created' }));
    const app = setup({ engine: { requestDraft } } as unknown as MailAssistantRuntime);
    const path = '/api/agents/office/mail-assistant/results/result-1/draft-request';
    const input = {
      revision: 'a'.repeat(64),
      instructions: 'Answer customer',
      requestId: '00000000-0000-4000-8000-000000000027',
      newReply: true,
    };
    expect(
      (await request(app).post(path).set('Authorization', 'Bearer fixture').send(input)).status,
    ).toBe(200);
    expect(requestDraft).toHaveBeenCalledWith(owner, 'result-1', input);
    for (const extra of [
      { newReply: 'true' },
      { toRecipients: ['outside@example.invalid'] },
      { send: true },
    ])
      expect(
        (
          await request(app)
            .post(path)
            .set('Authorization', 'Bearer fixture')
            .send({ ...input, ...extra })
        ).status,
      ).toBe(400);
    expect(requestDraft).toHaveBeenCalledTimes(1);
  });
});

describe('attachment binary release HTTP boundary', () => {
  const path =
    '/api/agents/office/mail-assistant/results/result-1/attachments/file%2F%2B%3D/download';
  const revision = 'a'.repeat(64);
  const download = {
    bytes: Buffer.from('Nur Text'),
    name: 'Notiz.txt',
    contentType: 'text/plain',
    scan: {
      verdict: 'no_known_threats' as const,
      engine: 'ClamAV' as const,
      scannedAt: '2026-10-29T10:00:00Z',
      signaturesAt: '2026-10-29T09:00:00Z',
    },
  };
  test('requires auth, ignores client ownership and releases only attachment bytes with defensive headers', async () => {
    const downloadAttachment = jest.fn(async () => download);
    const app = setup({ engine: { downloadAttachment } } as unknown as MailAssistantRuntime);
    expect((await request(app).post(path).send({ revision })).status).toBe(401);
    const response = await request(app)
      .post(path + '?owner=other')
      .set('Authorization', 'Bearer fixture')
      .send({ revision });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(download.bytes);
    expect(response.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': String(download.bytes.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-mail-attachment-scan': 'no_known_threats',
      'x-mail-attachment-scanned-at': download.scan.scannedAt,
    });
    expect(response.headers['content-disposition']).toBe('attachment; filename="Notiz.txt"');
    expect(downloadAttachment).toHaveBeenCalledWith(owner, 'result-1', 'file/+=', revision);
    expect(downloadAttachment).toHaveBeenCalledTimes(1);
  });
  test.each([
    { revision: 'invalid' },
    { revision, url: 'https://attacker.invalid' },
    { revision, owner: 'other' },
  ])('rejects client-selected metadata: %j', async (body) => {
    const downloadAttachment = jest.fn(async () => download);
    const app = setup({ engine: { downloadAttachment } } as unknown as MailAssistantRuntime);
    expect(
      (await request(app).post(path).set('Authorization', 'Bearer fixture').send(body)).status,
    ).toBe(400);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });
  test.each([
    ['found', 422],
    ['unavailable', 503],
    ['busy', 429],
    ['size', 413],
  ] as const)('returns safe %s errors without binary output', async (reason, status) => {
    const app = setup({
      engine: {
        downloadAttachment: async () => {
          throw new MailAttachmentScanError(reason);
        },
      },
    } as unknown as MailAssistantRuntime);
    const response = await request(app)
      .post(path)
      .set('Authorization', 'Bearer fixture')
      .send({ revision });
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['x-mail-attachment-scan']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(download.bytes.toString());
  });
  test('bounds concurrent downloads and frees capacity only after work and response finish', async () => {
    let begun = 0;
    let ready!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const downloadAttachment = jest.fn(async () => {
      if (++begun === 2) ready();
      await pending;
      return download;
    });
    const app = setup({ engine: { downloadAttachment } } as unknown as MailAssistantRuntime);
    const start = () =>
      request(app).post(path).set('Authorization', 'Bearer fixture').send({ revision });
    const first = start().then((response) => response);
    const second = start().then((response) => response);
    await bothStarted;
    expect((await start()).status).toBe(429);
    expect(downloadAttachment).toHaveBeenCalledTimes(2);
    finish();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await start()).status).toBe(200);
    expect(downloadAttachment).toHaveBeenCalledTimes(3);
  });
  test('rejects multitenant identities before scan work', async () => {
    const downloadAttachment = jest.fn(async () => download);
    const app = setup({ engine: { downloadAttachment } } as unknown as MailAssistantRuntime, {
      id: owner,
      tenantId: 'tenant',
    });
    expect(
      (await request(app).post(path).set('Authorization', 'Bearer fixture').send({ revision }))
        .status,
    ).toBe(403);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });
});

describe('manual mail research HTTP boundary', () => {
  const prefix = '/api/agents/office/mail-assistant';
  const id = '00000000-0000-4000-8000-000000000001';
  test('requires authentication and CW01 identity for every route', async () => {
    const research = {
      settings: jest.fn(),
      saveSkill: jest.fn(),
      customers: jest.fn(),
      enqueue: jest.fn(),
      jobs: jest.fn(),
      job: jest.fn(),
      cancel: jest.fn(),
    };
    for (const identity of [undefined, { id: owner, tenantId: 'foreign' }]) {
      const app = setup({ research } as unknown as MailAssistantRuntime, identity);
      for (const [method, path] of [
        ['get', '/research/settings'],
        ['put', '/research/skills/wlan'],
        ['get', '/research/customers?profileId=odoo-user&search=customer'],
        ['post', '/results/result/research'],
        ['get', '/research/jobs'],
        ['get', `/research/jobs/${id}`],
        ['post', `/research/jobs/${id}/cancel`],
      ] as const) {
        const call = request(app)[method](prefix + path);
        if (identity) call.set('Authorization', 'Bearer fixture');
        expect((await call.send({})).status).toBe(identity ? 403 : 401);
      }
    }
    for (const fn of Object.values(research)) expect(fn).not.toHaveBeenCalled();
  });
  test('passes only authenticated owner and exact inputs; retains bare DTO envelopes', async () => {
    const skill = { id: 'wlan', revision: 'a'.repeat(64) };
    const job = { id, status: 'queued' };
    const research = {
      settings: jest.fn(async () => ({ available: true, profiles: [], skills: [skill] })),
      saveSkill: jest.fn(async () => skill),
      customers: jest.fn(async () => [{ id: '22', name: 'Customer' }]),
      enqueue: jest.fn(async () => job),
      jobs: jest.fn(async () => [job]),
      job: jest.fn(async () => job),
      cancel: jest.fn(async () => ({ ...job, status: 'cancelled' })),
    };
    const app = setup({ research } as unknown as MailAssistantRuntime);
    const get = (path: string) =>
      request(app)
        .get(prefix + path)
        .set('Authorization', 'Bearer fixture');
    expect((await get('/research/settings')).body.skills).toEqual([skill]);
    expect((await get('/research/jobs')).body).toEqual([job]);
    expect((await get(`/research/jobs/${id}`)).body).toEqual(job);
    expect((await get('/research/customers?profileId=odoo-user&search=customer')).body).toEqual([
      { id: '22', name: 'Customer' },
    ]);
    expect(research.customers).toHaveBeenCalledWith(owner, 'odoo-user', 'customer');
    expect(
      (await get('/research/customers?profileId=odoo-user&search=customer&owner=foreign')).status,
    ).toBe(400);
    const input = { expectedRevision: '', name: 'Skill' };
    expect(
      (
        await request(app)
          .put(prefix + '/research/skills/wlan')
          .set('Authorization', 'Bearer fixture')
          .send(input)
      ).body,
    ).toEqual(skill);
    expect(research.saveSkill).toHaveBeenCalledWith(owner, 'wlan', input);
    const run = { requestId: id };
    const queued = await request(app)
      .post(prefix + '/results/result/research')
      .set('Authorization', 'Bearer fixture')
      .send(run);
    expect(queued.status).toBe(202);
    expect(queued.headers['cache-control']).toBe('no-store');
    expect(research.enqueue).toHaveBeenCalledWith(owner, 'result', run);
    expect(
      (
        await request(app)
          .post(prefix + `/research/jobs/${id}/cancel`)
          .set('Authorization', 'Bearer fixture')
          .send({ owner: 'foreign' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(prefix + `/research/jobs/${id}/cancel`)
          .set('Authorization', 'Bearer fixture')
          .send({})
      ).body.status,
    ).toBe('cancelled');
    expect(research.cancel).toHaveBeenCalledWith(owner, id);
  });
});
