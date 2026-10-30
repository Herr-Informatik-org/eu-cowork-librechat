import type { Agent } from 'librechat-data-provider';
import type { JsonValue } from './envelope';
import { getProviderConfig } from '~/endpoints/config/providers';
import { recordCollectedUsage } from './usage';
import {
  executeSupportAnalysis,
  getSupportRuntimeStatus,
  isSupportServiceIdentity,
  restrictSupportServiceRoute,
  SUPPORT_RUNTIME_PROFILE,
} from './support';
import { createRun } from './run';

jest.mock('@librechat/agents', () => ({ Providers: { OPENAI: 'openai' } }));
jest.mock('~/endpoints/config/providers', () => ({ getProviderConfig: jest.fn() }));
jest.mock('~/app/config', () => ({
  getBalanceConfig: jest.fn(() => ({})),
  getTransactionsConfig: jest.fn(() => ({ enabled: true })),
}));
jest.mock('./usage', () => ({ recordCollectedUsage: jest.fn() }));
jest.mock('./run', () => ({ createRun: jest.fn() }));

const endpoint = 'https://api.eurouter.ai/api/v1';
const originalEnvironment = { ...process.env };
const storedAgent: Agent = {
  id: 'support-agent',
  name: 'Support',
  model: 'mistral-large-3',
  provider: 'EuRouter',
  model_parameters: { model: 'evil-model', tools: [{ name: 'send_email' }] } as never,
  created_at: 0,
  description: null,
  avatar: null,
  instructions: 'Read personal Brain and send email.',
  tools: ['send_email', 'execute_code'],
  tool_resources: { file_search: { file_ids: ['private-file'] } },
  skills: ['private-skill'],
  skills_enabled: true,
  agent_ids: ['other-agent'],
};

function request() {
  return {
    body: {
      model: 'support-agent',
      input: JSON.stringify({ task: 'analyse', context: {}, result_schema: {} }),
      max_output_tokens: 800,
    } as { [key: string]: JsonValue },
    user: { id: 'service-user', role: 'USER', tenantId: 'tenant-a' },
    config: {
      config: {},
      imageOutputType: 'png',
      fileStrategy: 'local',
      endpoints: {
        custom: [
          {
            name: 'EuRouter',
            baseURL: endpoint,
            apiKey: 'fixture-not-a-real-key',
            headers: { 'x-private': 'private' },
            addParams: { tools: ['remote-tool'], model: 'other-model' },
            models: { fetch: true, default: ['mistral-large-3'] },
          },
        ],
        agents: { capabilities: ['skills', 'execute_code', 'memory', 'run_in_background'] },
      },
      memory: { disabled: false },
      langfuse: { enabled: true },
    },
  };
}

const getOptions = jest.fn();
const processStream = jest.fn();
const getAgent = jest.fn();
const usage = { spendTokens: jest.fn(), spendStructuredTokens: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, {
    KISUNO_SUPPORT_API_ENABLED: 'true',
    KISUNO_SUPPORT_AGENT_ID: 'support-agent',
    KISUNO_SUPPORT_PROVIDER: 'EuRouter',
    KISUNO_SUPPORT_MODEL: 'mistral-large-3',
    KISUNO_SUPPORT_SERVICE_USER_ID: 'service-user',
  });
  getAgent.mockResolvedValue(storedAgent);
  getOptions.mockResolvedValue({
    llmConfig: { apiKey: 'fixture-not-a-real-key' },
    configOptions: { baseURL: endpoint },
  });
  jest
    .mocked(getProviderConfig)
    .mockReturnValue({ getOptions, overrideProvider: 'openai', customEndpointConfig: {} });
  jest.mocked(createRun).mockImplementation(async (args) => {
    await args.customHandlers?.on_chat_model_end?.handle?.(
      'on_chat_model_end',
      {
        output: { usage_metadata: { input_tokens: 20, output_tokens: 30 } },
      },
      {},
    );
    return { processStream } as never;
  });
  processStream.mockResolvedValue([{ type: 'text', text: '{"summary":"Nur ein Entwurf."}' }]);
});

afterAll(() => {
  process.env = originalEnvironment;
});

const execute = (req = request(), signal = new AbortController().signal) =>
  executeSupportAnalysis(req as never, signal, { getAgent, usage });

test('reuses one runtime with zero tools, Brain, files, skills, handoffs or personal context', async () => {
  const result = await execute();
  expect(result).toEqual({
    profile: SUPPORT_RUNTIME_PROFILE,
    analysis: { summary: 'Nur ein Entwurf.' },
    usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
    model: 'mistral-large-3',
    provider: 'EuRouter',
    region: 'EU',
  });
  expect(createRun).toHaveBeenCalledTimes(1);
  const run = jest.mocked(createRun).mock.calls[0][0];
  expect(run.agents).toHaveLength(1);
  expect(run.agents[0]).toMatchObject({
    tools: [],
    toolDefinitions: [],
    brainTools: [],
    edges: [],
    agent_ids: [],
    skills: [],
    skills_enabled: false,
    stateful_code_sessions: false,
    model_parameters: { model: 'mistral-large-3', maxTokens: 800, maxRetries: 0 },
  });
  for (const field of [
    'tool_resources',
    'subagents',
    'toolRegistry',
    'attachments',
    'additional_instructions',
  ]) {
    expect(run.agents[0]).not.toHaveProperty(field);
  }
  expect(run.agents[0].instructions).not.toContain(storedAgent.instructions);
  expect(run).toMatchObject({
    user: { id: 'service-user', tenantId: 'tenant-a' },
    tenantId: 'tenant-a',
    centralTraceExportEnabled: false,
    summarizationConfig: { enabled: false },
    hitlCapable: false,
  });
  expect(run.appConfig).not.toHaveProperty('memory');
  expect(run.appConfig).not.toHaveProperty('langfuse');
  expect(run.appConfig).not.toHaveProperty('mcpConfig');
  expect(run.appConfig?.endpoints).not.toHaveProperty('agents');
  expect(getOptions.mock.calls[0][0].req.body).toEqual({});
  expect(getOptions.mock.calls[0][0].req.config.endpoints.custom[0]).not.toHaveProperty('headers');
  expect(getOptions.mock.calls[0][0].req.config.endpoints.custom[0]).not.toHaveProperty(
    'addParams',
  );
  expect(recordCollectedUsage).toHaveBeenCalledWith(
    usage,
    expect.objectContaining({ user: 'service-user', model: 'mistral-large-3' }),
  );
});

test.each([undefined, 'false', '1'])('is disabled unless explicitly true: %s', async (value) => {
  if (value === undefined) delete process.env.KISUNO_SUPPORT_API_ENABLED;
  else process.env.KISUNO_SUPPORT_API_ENABLED = value;
  await expect(execute()).rejects.toMatchObject({ code: 'support_disabled' });
  expect(getAgent).not.toHaveBeenCalled();
});

test.each([
  'KISUNO_SUPPORT_AGENT_ID',
  'KISUNO_SUPPORT_MODEL',
  'KISUNO_SUPPORT_PROVIDER',
  'KISUNO_SUPPORT_SERVICE_USER_ID',
])('requires %s', async (key) => {
  delete process.env[key];
  await expect(execute()).rejects.toMatchObject({ code: 'support_profile_unconfigured' });
});

test.each([
  'tools',
  'tool_choice',
  'conversation_id',
  'manualSkills',
  'ephemeralAgent',
  'approved',
  'instructions',
])('rejects extra field %s', async (key) => {
  const req = request();
  req.body[key] = [];
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_invalid_request' });
  expect(createRun).not.toHaveBeenCalled();
});

test.each([0, -1, 4097, 1.2, '100'])('rejects invalid output budget %s', async (tokens) => {
  const req = request();
  req.body.max_output_tokens = tokens;
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_invalid_request' });
});

test('rejects oversized input and another agent', async () => {
  const req = request();
  req.body.input = 'x'.repeat(80001);
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_invalid_request' });
  req.body.input = '{}';
  req.body.model = 'other-agent';
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_invalid_request' });
});

test('rejects a caller outside the pinned technical identity', async () => {
  const req = request();
  req.user.id = 'employee';
  await expect(execute(req)).rejects.toMatchObject({
    status: 403,
    code: 'support_service_required',
  });
  expect(getAgent).not.toHaveBeenCalled();
});

test.each([{ ...storedAgent, provider: 'other' }, { ...storedAgent, model: 'other' }, null])(
  'rejects changed or removed profile',
  async (agent) => {
    getAgent.mockResolvedValue(agent);
    await expect(execute()).rejects.toMatchObject({ code: 'support_profile_changed' });
    expect(createRun).not.toHaveBeenCalled();
  },
);

test.each([
  'https://example.invalid/v1',
  'user_provided',
  'http://api.eurouter.ai/api/v1',
  `${endpoint}?route=global`,
])('refuses non-pinned URL %s', async (url) => {
  const req = request();
  req.config.endpoints.custom[0].baseURL = url;
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_provider_policy' });
  expect(getOptions).not.toHaveBeenCalled();
});

test('refuses user credentials and denies key lookup even if the initializer tries', async () => {
  const req = request();
  req.config.endpoints.custom[0].apiKey = 'user_provided';
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_provider_policy' });
  await execute();
  await expect(getOptions.mock.calls[0][0].db.getUserKeyValues({})).rejects.toMatchObject({
    code: 'support_user_key_forbidden',
  });
});

test('checks the effective initialized endpoint again', async () => {
  getOptions.mockResolvedValue({
    llmConfig: { apiKey: 'fixture-not-a-real-key' },
    configOptions: { baseURL: 'https://example.invalid' },
  });
  await expect(execute()).rejects.toMatchObject({ code: 'support_provider_policy' });
  expect(createRun).not.toHaveBeenCalled();
});

test.each(['not JSON', '[]', 'null', '"text"'])(
  'rejects malformed result but records spent tokens: %s',
  async (text) => {
    processStream.mockResolvedValue([{ type: 'text', text }]);
    await expect(execute()).rejects.toMatchObject({ code: 'support_invalid_output' });
    expect(recordCollectedUsage).toHaveBeenCalledTimes(1);
  },
);

test('does not retry a failed run and records received usage', async () => {
  processStream.mockRejectedValue(new Error('network failure'));
  await expect(execute()).rejects.toThrow('network failure');
  expect(createRun).toHaveBeenCalledTimes(1);
  expect(processStream).toHaveBeenCalledTimes(1);
  expect(recordCollectedUsage).toHaveBeenCalledTimes(1);
});

test('does not declare success without usage or after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(execute(request(), abort.signal)).rejects.toMatchObject({
    code: 'support_cancelled',
  });
  jest.mocked(createRun).mockResolvedValue({ processStream } as never);
  await expect(execute()).rejects.toMatchObject({ code: 'support_usage_missing' });
});

test('blocks recognizable credentials even with optional PII configuration absent', async () => {
  const req = request();
  req.body.input = 'Passwort: synthetic-password-value';
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_sensitive_input' });
  expect(createRun).not.toHaveBeenCalled();
});

test.each([
  [{}, 'support_usage_missing'],
  [{ output_tokens: 5 }, 'support_usage_missing'],
  [{ input_tokens: 5 }, 'support_usage_missing'],
  [{ input_tokens: -1, output_tokens: 5 }, 'support_usage_invalid'],
  [{ input_tokens: 1.5, output_tokens: 5 }, 'support_usage_invalid'],
  [{ input_tokens: 5, output_tokens: Number.NaN }, 'support_usage_invalid'],
  [{ input_tokens: 5, output_tokens: Number.MAX_SAFE_INTEGER }, 'support_usage_invalid'],
])(
  'rejects incomplete or invalid usage without inventing zero costs: %j',
  async (metadata, code) => {
    jest.mocked(createRun).mockImplementation(async (args) => {
      await args.customHandlers?.on_chat_model_end?.handle?.(
        'on_chat_model_end',
        {
          output: { usage_metadata: metadata },
        },
        {},
      );
      return { processStream } as never;
    });
    await expect(execute()).rejects.toMatchObject({ code });
    expect(recordCollectedUsage).not.toHaveBeenCalled();
  },
);

test('records actual spend but rejects a provider exceeding the requested output budget', async () => {
  const req = request();
  req.body.max_output_tokens = 10;
  await expect(execute(req)).rejects.toMatchObject({ code: 'support_output_budget_exceeded' });
  expect(recordCollectedUsage).toHaveBeenCalledTimes(1);
});

test('readiness checks the fixed profile without starting a model run', async () => {
  expect(await getSupportRuntimeStatus(request() as never, { getAgent })).toEqual({
    ready: true,
    profile: SUPPORT_RUNTIME_PROFILE,
    provider: 'EuRouter',
    model: 'mistral-large-3',
    tools: false,
    personal_brain: false,
  });
  expect(createRun).not.toHaveBeenCalled();
  expect(recordCollectedUsage).not.toHaveBeenCalled();
});

test('readiness refuses disabled or different identities and non-EU endpoints', async () => {
  const req = request();
  req.user.id = 'employee';
  await expect(getSupportRuntimeStatus(req as never, { getAgent })).rejects.toMatchObject({
    status: 403,
  });
  req.user.id = 'service-user';
  process.env.KISUNO_SUPPORT_API_ENABLED = 'false';
  await expect(getSupportRuntimeStatus(req as never, { getAgent })).rejects.toMatchObject({
    status: 404,
  });
  process.env.KISUNO_SUPPORT_API_ENABLED = 'true';
  req.config.endpoints.custom[0].baseURL = 'https://global.invalid';
  await expect(getSupportRuntimeStatus(req as never, { getAgent })).rejects.toMatchObject({
    status: 503,
  });
  expect(createRun).not.toHaveBeenCalled();
});

test.each([
  ['POST', '/api/agents/v1/chat/completions'],
  ['POST', '/api/agents/v1/responses'],
  ['GET', '/api/agents/v1/models'],
  ['GET', '/api/agents/v1/support-analysis'],
  ['POST', '/api/agents/v1/support-status'],
])('internal identity cannot use %s %s', (method, originalUrl) => {
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  restrictSupportServiceRoute(
    { user: { id: 'service-user', role: 'KISUNO_SUPPORT_RUNTIME' }, method, originalUrl } as never,
    res as never,
    next,
  );
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test.each([
  ['POST', '/api/agents/v1/support-analysis'],
  ['GET', '/api/agents/v1/support-status'],
])('internal identity may use %s %s', (method, originalUrl) => {
  const next = jest.fn();
  restrictSupportServiceRoute(
    { user: { id: 'service-user', role: 'KISUNO_SUPPORT_RUNTIME' }, method, originalUrl } as never,
    {} as never,
    next,
  );
  expect(next).toHaveBeenCalledTimes(1);
});

test('internal role remains restricted if its environment mapping is removed', () => {
  delete process.env.KISUNO_SUPPORT_SERVICE_USER_ID;
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  restrictSupportServiceRoute(
    {
      user: { id: 'service-user', role: 'KISUNO_SUPPORT_RUNTIME' },
      method: 'POST',
      originalUrl: '/api/agents/v1/chat/completions',
    } as never,
    res as never,
    next,
  );
  expect(res.status).toHaveBeenCalledWith(403);
});

test('readiness rejects malformed sensitive-input filter configuration', async () => {
  const req = request();
  Object.assign(req.config, { messageFilter: { pii: { starterPatterns: 'invalid' } } });
  await expect(getSupportRuntimeStatus(req as never, { getAgent })).rejects.toMatchObject({
    code: 'support_filter_unconfigured',
  });
  expect(createRun).not.toHaveBeenCalled();
});

test.each([
  { role: 'KISUNO_SUPPORT_RUNTIME' },
  { provider: 'kisuno-support-runtime' },
  { email: 'support-runtime@kisuno.invalid' },
  { id: 'service-user' },
])('identifies the service account independently of alternate changed fields: %s', (user) => {
  expect(isSupportServiceIdentity(user)).toBe(true);
});

test('does not treat an ordinary employee as a support service identity', () => {
  expect(
    isSupportServiceIdentity({
      id: 'employee',
      provider: 'openid',
      role: 'USER',
      email: 'person@example.invalid',
    }),
  ).toBe(false);
});
