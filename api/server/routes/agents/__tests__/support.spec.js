const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  executeSupportAnalysis: jest.fn(),
  getSupportRuntimeStatus: jest.fn(),
  SUPPORT_RUNTIME_PROFILE: 'kisuno-support-v1',
  SupportRuntimeError: class SupportRuntimeError extends Error {
    constructor(status, code) {
      super('Nicht verfügbar.');
      this.status = status;
      this.code = code;
    }
  },
}));
jest.mock('~/models', () => ({
  getAgent: jest.fn(),
  spendTokens: jest.fn(),
  spendStructuredTokens: jest.fn(),
}));
jest.mock('~/server/controllers/agents/openai', () => ({
  OpenAIChatCompletionController: jest.fn(),
  ListModelsController: jest.fn(),
  GetModelController: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({ configMiddleware: (_req, _res, next) => next() }));
jest.mock('../middleware', () => ({
  preAuthTenantMiddleware: (_req, _res, next) => next(),
  requireRemoteAgentAuth: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer synthetic-fixture') return res.sendStatus(401);
    req.user = { id: 'service-user', tenantId: 'tenant-a' };
    next();
  },
  checkRemoteAgentsFeature: (_req, _res, next) => next(),
  checkAgentPermission: (req, res, next) => {
    if (req.headers['x-fixture-agent-access'] !== 'yes') return res.sendStatus(403);
    next();
  },
}));

const {
  executeSupportAnalysis,
  getSupportRuntimeStatus,
  SupportRuntimeError,
} = require('@librechat/api');
const router = require('../openai');
const app = express();
app.use(express.json());
app.use('/api/agents/v1', router);
const path = '/api/agents/v1/support-analysis';
const invoke = () =>
  request(app)
    .post(path)
    .set('Authorization', 'Bearer synthetic-fixture')
    .set('x-fixture-agent-access', 'yes');

beforeEach(() => {
  executeSupportAnalysis.mockReset();
  getSupportRuntimeStatus.mockReset();
});

test('requires authentication and agent permission before reaching the runtime', async () => {
  await request(app).post(path).send({}).expect(401);
  await request(app)
    .post(path)
    .set('Authorization', 'Bearer synthetic-fixture')
    .send({})
    .expect(403);
  expect(executeSupportAnalysis).not.toHaveBeenCalled();
});

test('returns the explicit profile with no-cache semantics', async () => {
  executeSupportAnalysis.mockResolvedValue({
    profile: 'kisuno-support-v1',
    analysis: { summary: 'Test' },
  });
  const response = await invoke()
    .send({ model: 'support-agent', input: '{}', max_output_tokens: 20 })
    .expect(200);
  expect(response.headers['x-kisuno-runtime-profile']).toBe('kisuno-support-v1');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(executeSupportAnalysis.mock.calls[0][0].user).toEqual({
    id: 'service-user',
    tenantId: 'tenant-a',
  });
  expect(response.body.analysis.summary).toBe('Test');
});

test('returns safe fixed errors without reflecting provider messages', async () => {
  executeSupportAnalysis.mockRejectedValue(new Error('sensitive provider response'));
  const response = await invoke().send({}).expect(502);
  expect(response.body.error.code).toBe('support_runtime_failed');
  expect(JSON.stringify(response.body)).not.toContain('sensitive');
});

test('retains deliberate disabled and profile policy failures', async () => {
  executeSupportAnalysis.mockRejectedValue(new SupportRuntimeError(404, 'support_disabled'));
  const response = await invoke().send({}).expect(404);
  expect(response.body.error.code).toBe('support_disabled');
});

test('status retains authentication, fixed agent permission and no-store semantics', async () => {
  const statusPath = '/api/agents/v1/support-status';
  const savedAgentId = process.env.KISUNO_SUPPORT_AGENT_ID;
  process.env.KISUNO_SUPPORT_AGENT_ID = 'fixed-support-agent';
  await request(app).get(statusPath).expect(401);
  await request(app).get(statusPath).set('Authorization', 'Bearer synthetic-fixture').expect(403);
  getSupportRuntimeStatus.mockResolvedValue({
    ready: true,
    profile: 'kisuno-support-v1',
    tools: false,
    personal_brain: false,
  });
  const response = await request(app)
    .get(statusPath)
    .set('Authorization', 'Bearer synthetic-fixture')
    .set('x-fixture-agent-access', 'yes')
    .send({ model: 'untrusted-other-agent' })
    .expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({ ready: true, tools: false, personal_brain: false });
  expect(executeSupportAnalysis).not.toHaveBeenCalled();
  expect(getSupportRuntimeStatus.mock.calls[0][0].body.model).toBe('fixed-support-agent');
  if (savedAgentId === undefined) delete process.env.KISUNO_SUPPORT_AGENT_ID;
  else process.env.KISUNO_SUPPORT_AGENT_ID = savedAgentId;
});
