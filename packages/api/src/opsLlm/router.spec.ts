jest.mock('~/admin/secrets', () => ({
  resolveCustomEndpointSecrets: (value: object) => value,
  resolveConfigSecret: (value: string) => value,
}));
const mockStore = {
  authorize: jest.fn(),
  active: jest.fn(),
  reserve: jest.fn(),
  meter: jest.fn(),
  list: jest.fn(),
  create: jest.fn(),
  rotate: jest.fn(),
  revoke: jest.fn(),
};
jest.mock('./store', () => ({ createOpsStore: () => mockStore }));
import express from 'express';
import request from 'supertest';
import type { AppConfig } from '@librechat/data-schemas';
import type { OpsRouterDependencies } from './router';
import { createOpsLlmRouters } from './router';
import { OpsLlmError } from './config';
import { createHash } from 'node:crypto';
import { OpsPersonalError } from '../opsPersonal/service';
import type { OpsPersonalContext } from '../opsPersonal/types';
const env = {
  KISUNO_OPS_TENANT_ID: 'cwv01',
  KISUNO_OPS_INTERNAL_ENABLED: 'true',
  KISUNO_OPS_PROVIDER_POLICY_JSON: JSON.stringify({
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'test/model',
    noRetention: true,
    credentialFingerprint: createHash('sha256').update('test-key-not-real').digest('hex'),
    jsonObject: true,
    reviewedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2090-01-01T00:00:00Z',
    reference: 'Test contract',
  }),
};
const personalMail = { sender: 'sender@example.test', subject: 'Subject', text: 'Untrusted mail' };
const payload = {
  model: 'kisuno-default',
  messages: [{ role: 'user', content: 'private prompt' }],
};
const providerResponse = () =>
  new Response(
    JSON.stringify({
      model: 'test/model',
      choices: [
        { message: { role: 'assistant', content: 'private result' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
function setup(overrides: Partial<OpsRouterDependencies> = {}) {
  const fetcher = jest.fn(async () => providerResponse());
  const release = jest.fn(async () => undefined);
  const dependencies: OpsRouterDependencies = {
    env,
    collection: jest.fn(),
    authorizeAdmin: async () => true,
    fetch: fetcher,
    getCentralConfig: async () =>
      ({
        modelSpecs: {
          list: [{ default: true, preset: { endpoint: 'Test', model: 'test/model' } }],
        },
        endpoints: {
          custom: [
            { name: 'Test', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'test-key-not-real' },
          ],
        },
      }) as AppConfig,
    getCentralAgent: async () => null,
    personalIdentity: async () => 'owner',
    ...overrides,
  };
  mockStore.authorize.mockResolvedValue({ _id: 'key1', hash: 'hash' });
  mockStore.reserve.mockResolvedValue(release);
  mockStore.active.mockResolvedValue(undefined);
  mockStore.meter.mockResolvedValue(undefined);
  mockStore.list.mockResolvedValue([]);
  const routers = createOpsLlmRouters(dependencies);
  const app = express();
  app.use('/v1', routers.publicRouter);
  app.use('/personal/completions', routers.personalRouter);
  app.use('/admin', express.json(), routers.adminRouter);
  return { app, fetcher, release };
}
beforeEach(() => jest.resetAllMocks());
describe('OPS HTTP boundary', () => {
  test('strict body and supported paths only; no content metering', async () => {
    const { app, fetcher, release } = setup();
    const result = await request(app)
      .post('/v1/chat/completions')
      .set('X-Kisuno-Modul', 'mail')
      .send(payload);
    expect(result.status).toBe(200);
    expect(result.body.model).toBe('test/model');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(mockStore.meter).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'key1',
        module: 'mail',
        model: 'test/model',
        input: 3,
        output: 2,
        status: 'success',
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockStore.meter.mock.calls)).not.toContain('private');
    expect((await request(app).post('/v1/responses').send(payload)).status).toBe(404);
    expect(
      (
        await request(app)
          .post('/v1/chat/completions')
          .send({ ...payload, tools: [] })
      ).status,
    ).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('rejects tenant header, disabled feature, oversized and invalid JSON before inference', async () => {
    const { app, fetcher } = setup();
    expect(
      (await request(app).post('/v1/chat/completions').set('X-Tenant-ID', 'cwv02').send(payload))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/v1/chat/completions')
          .send({ ...payload, extra: 'x'.repeat(270000) })
      ).status,
    ).toBe(413);
    expect((await request(app).post('/v1/chat/completions').type('json').send('{')).status).toBe(
      400,
    );
    expect(
      (
        await request(setup({ env: {} }).app)
          .post('/v1/chat/completions')
          .send(payload)
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('key revoked while inference runs suppresses response', async () => {
    const { app, release } = setup();
    mockStore.active
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new OpsLlmError(401, 'invalid_api_key', 'Widerrufen.'));
    const result = await request(app).post('/v1/chat/completions').send(payload);
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain('private result');
    expect(mockStore.meter).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorCode: 'invalid_api_key' }),
    );
    expect(release).toHaveBeenCalled();
  });
  test('rate limit returns Retry-After and never starts provider', async () => {
    const { app, fetcher } = setup();
    mockStore.reserve.mockRejectedValue(
      new OpsLlmError(429, 'rate_limit_exceeded', 'Ausgelastet.', 60),
    );
    const result = await request(app).post('/v1/chat/completions').send(payload);
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('60');
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('administrator capability gate covers listing and mutation', async () => {
    const { app } = setup({ authorizeAdmin: async () => false });
    expect((await request(app).get('/admin/keys')).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/admin/keys')
          .send({ name: 'x', modules: ['mail'] })
      ).status,
    ).toBe(403);
    expect(mockStore.create).not.toHaveBeenCalled();
  });
  test('deadline abort reaches upstream and quota is released', async () => {
    const fetcher = jest.fn(
      (_url: string | URL | Request, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        ),
    );
    const { app, release } = setup({
      env: { ...env, KISUNO_OPS_TIMEOUT_MS: '1000' },
      fetch: fetcher,
    });
    expect((await request(app).post('/v1/chat/completions').send(payload)).status).toBe(504);
    expect(release).toHaveBeenCalled();
  });
  test('browser-origin API calls fail closed before reading bearer keys', async () => {
    const { app, fetcher } = setup();
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Origin', 'https://ops.rzcloud.ch')
      .send(payload);
    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockStore.authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('personal input is owner-scoped context only and returns source metadata', async () => {
    const active = jest.fn(async () => undefined);
    const context = {
      contextText: 'private owned context',
      ownerId: 'owner',
      grantId: 'grant1',
      subject: 'owner',
      sourcesUsed: { skills: [{ id: 's1', name: 'Style', version: '1' }], brain: true },
      assertActive: active,
    } as OpsPersonalContext;
    const resolve = jest.fn(async () => context);
    const { app, fetcher } = setup({ personalContext: resolve });
    const result = await request(app)
      .post('/personal/completions')
      .set('X-OPS-User-ID', 'ops-user')
      .send({
        task: 'mail_draft',
        instruction: 'draft please',
        mail: personalMail,
        skill_ids: ['s1'],
        brain: true,
        background: false,
      });
    expect(result.status).toBe(200);
    expect(result.body.sources_used).toEqual(context.sourcesUsed);
    expect(JSON.stringify(result.body)).not.toContain('private owned context');
    expect(active).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(app)
          .post('/personal/completions')
          .send({ task: 'mail_draft', instruction: 'draft', mail: personalMail, ownerId: 'other' })
      ).status,
    ).toBe(400);
  });
  test('personal context bound covers Skill and Brain; revocation blocks publication', async () => {
    const active = jest.fn(async () => undefined);
    const context = {
      contextText: 'x'.repeat(33000),
      ownerId: 'owner',
      grantId: 'grant1',
      subject: 'owner',
      sourcesUsed: { skills: [], brain: true },
      assertActive: active,
    } as OpsPersonalContext;
    const { app, fetcher } = setup({ personalContext: async () => context });
    expect(
      (
        await request(app)
          .post('/personal/completions')
          .send({ task: 'mail_draft', instruction: 'draft', mail: personalMail })
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    context.contextText = 'context';
    active
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new OpsPersonalError(401, 'invalid_grant'));
    const response = await request(app)
      .post('/personal/completions')
      .send({ task: 'mail_draft', instruction: 'draft', mail: personalMail });
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('private result');
  });
  test('background requests cannot create drafts or embed attachment bytes', async () => {
    const { app, fetcher } = setup();
    expect(
      (
        await request(app)
          .post('/personal/completions')
          .send({ task: 'mail_draft', instruction: 'draft', mail: personalMail, background: true })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/personal/completions')
          .send({
            task: 'mail_review',
            instruction: 'review',
            mail: {
              ...personalMail,
              attachments: [
                { name: 'file', content_type: 'text/plain', size_bytes: 5, content: 'bytes' },
              ],
            },
          })
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('personal rate limit is reserved before reading Skills or Brain', async () => {
    const context = jest.fn();
    const { app, fetcher } = setup({ personalContext: context });
    mockStore.reserve.mockRejectedValueOnce(
      new OpsLlmError(429, 'rate_limit_exceeded', 'Ausgelastet.', 60),
    );
    const response = await request(app)
      .post('/personal/completions')
      .send({ task: 'mail_review', instruction: 'review', mail: personalMail, brain: true });
    expect(response.status).toBe(429);
    expect(context).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mockStore.reserve).toHaveBeenCalledWith('personal:owner', expect.any(Object));
  });
  test.each([
    { content: '{}', finish: 'stop' },
    {
      content: '{"summary":"ok","open_questions":[],"next_step":"review","extra":"x"}',
      finish: 'stop',
    },
    { content: '{"summary":"ok","open_questions":[],"next_step":"review"}', finish: 'length' },
  ])('review response is complete and strictly structured: %j', async ({ content, finish }) => {
    const context = {
      contextText: '',
      ownerId: 'owner',
      sourcesUsed: { skills: [], brain: false },
      assertActive: async () => undefined,
    } as OpsPersonalContext;
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'test/model',
            choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        ),
    );
    const { app } = setup({ personalContext: async () => context, fetch: fetcher });
    const response = await request(app)
      .post('/personal/completions')
      .send({ task: 'mail_review', instruction: 'review', mail: personalMail, background: true });
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('invalid_review_response');
    expect(mockStore.meter).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', errorCode: 'invalid_review_response' }),
    );
  });
  test('hard deadline responds while context waits and late resolution cannot start inference', async () => {
    let resolveContext: (value: OpsPersonalContext) => void = () => undefined;
    const pending = new Promise<OpsPersonalContext>((resolve) => {
      resolveContext = resolve;
    });
    const { app, fetcher, release } = setup({
      env: { ...env, KISUNO_OPS_TIMEOUT_MS: '1000' },
      personalContext: () => pending,
    });
    const response = await request(app)
      .post('/personal/completions')
      .send({ task: 'mail_review', instruction: 'review', mail: personalMail });
    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe('request_timeout');
    expect(fetcher).not.toHaveBeenCalled();
    resolveContext({
      contextText: '',
      ownerId: 'owner',
      sourcesUsed: { skills: [], brain: false },
      assertActive: async () => undefined,
    } as OpsPersonalContext);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetcher).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
