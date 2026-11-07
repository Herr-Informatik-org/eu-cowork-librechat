import { Run } from '@librechat/agents';
import type { Agent } from 'librechat-data-provider';
import { executeSupportAnalysis } from './support';

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Run: { create: jest.fn() },
}));
jest.mock('./usage', () => ({ recordCollectedUsage: jest.fn() }));

test('real initializer and run builder produce one EuRouter model with no executable surface', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    KISUNO_SUPPORT_API_ENABLED: 'true',
    KISUNO_SUPPORT_AGENT_ID: 'support-agent',
    KISUNO_SUPPORT_PROVIDER: 'EuRouter',
    KISUNO_SUPPORT_MODEL: 'mistral-large-3',
    KISUNO_SUPPORT_SERVICE_USER_ID: 'service-user',
    LANGFUSE_ENABLED: 'true',
  });
  const processStream = jest
    .fn()
    .mockResolvedValue([{ type: 'text', text: '{"summary":"synthetisch"}' }]);
  jest.mocked(Run.create).mockImplementation(async (config) => {
    await config.customHandlers?.on_chat_model_end?.handle?.(
      'on_chat_model_end',
      {
        output: { usage_metadata: { input_tokens: 12, output_tokens: 4 } },
      },
      {},
    );
    return { processStream } as never;
  });
  const req = {
    user: { id: 'service-user', role: 'USER', tenantId: 'tenant-a' },
    body: {
      model: 'support-agent',
      input: '{"task":"summarize","context":{},"result_schema":{}}',
      max_output_tokens: 800,
    },
    config: {
      config: {},
      fileStrategy: 'local',
      imageOutputType: 'png',
      endpoints: {
        custom: [
          {
            name: 'EuRouter',
            baseURL: 'https://api.eurouter.ai/api/v1',
            apiKey: 'synthetic-fixture-credential',
            models: { default: ['mistral-large-3'], fetch: false },
            headers: { 'x-identity': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
            addParams: { model: 'other-model', tools: [{ type: 'web_search' }] },
          },
        ],
      },
      langfuse: { enabled: true },
      memory: { disabled: false },
    },
  };
  try {
    const result = await executeSupportAnalysis(req as never, new AbortController().signal, {
      getAgent: jest.fn().mockResolvedValue({
        id: 'support-agent',
        provider: 'EuRouter',
        model: 'mistral-large-3',
      } as Agent),
      usage: { spendTokens: jest.fn(), spendStructuredTokens: jest.fn() },
    });
    expect(result.analysis).toEqual({ summary: 'synthetisch' });
    expect(Run.create).toHaveBeenCalledTimes(1);
    const config = jest.mocked(Run.create).mock.calls[0][0];
    expect(config.graphConfig.agents).toHaveLength(1);
    const agent = config.graphConfig.agents[0];
    expect(agent).toMatchObject({
      tools: [],
      toolDefinitions: [],
      summarizationEnabled: false,
      clientOptions: {
        model: 'mistral-large-3',
        maxTokens: 800,
        maxRetries: 0,
        streamUsage: true,
        configuration: { baseURL: 'https://api.eurouter.ai/api/v1', maxRetries: 0 },
        modelKwargs: {
          response_format: { type: 'json_object' },
          store: false,
          provider: { allow_fallbacks: false, data_collection: 'deny' },
        },
      },
    });
    for (const field of ['graphTools', 'subagentConfigs', 'toolRegistry'])
      expect(agent[field]).toBeUndefined();
    expect(agent.clientOptions.configuration).not.toHaveProperty('defaultHeaders');
    expect(config.langfuse?.enabled).toBe(false);
    expect(config).not.toHaveProperty('humanInTheLoop');
    expect(config).not.toHaveProperty('compileOptions.checkpointer');
    expect(processStream).toHaveBeenCalledTimes(1);
  } finally {
    process.env = saved;
  }
});
