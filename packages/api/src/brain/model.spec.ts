import { Providers } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type { TMemoryConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveBrainLearningModel, BrainLearningConfigurationError } from './model';
import type { BrainLearningModelOptions } from './model';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('~/endpoints/config/providers', () => ({ getProviderConfig: jest.fn() }));
const providerConfig = jest.mocked(getProviderConfig);
const targetPricing = { 'learning-model': { prompt: 0.4, completion: 0.8, context: 32000 } };
const primaryPricing = { 'chat-model': { prompt: 4, completion: 8, context: 128000 } };
const getOptions = jest.fn();

function options(agentConfig?: TMemoryConfig['agent']): BrainLearningModelOptions {
  return {
    req: {
      user: { id: 'owner' },
      body: {},
      config: { memory: { agent: agentConfig }, endpoints: {} } as AppConfig,
    } as ServerRequest,
    agent: {
      provider: Providers.OPENAI,
      model: 'saved-model',
      model_parameters: {
        model: 'chat-model',
        apiKey: 'synthetic-primary-key',
        configuration: { baseURL: 'https://primary.test/v1' },
      },
    },
    ids: { conversationId: 'conversation', messageId: 'response' },
    endpointTokenConfig: primaryPricing,
    db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  providerConfig.mockReturnValue({ getOptions, overrideProvider: Providers.OPENAI });
  getOptions.mockResolvedValue({
    llmConfig: { model: 'learning-model', apiKey: 'synthetic-target-key' },
    configOptions: {
      baseURL: 'https://target.test/v1',
      defaultHeaders: { 'x-conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
    },
    endpointTokenConfig: targetPricing,
  });
});

describe('Brain learning model selection', () => {
  it('uses the actually running model and connection only when no agent is configured', async () => {
    const result = await resolveBrainLearningModel(options());
    expect(result?.llmConfig).toMatchObject({
      model: 'chat-model',
      apiKey: 'synthetic-primary-key',
    });
    expect(result?.endpointTokenConfig).toBe(primaryPricing);
    expect(providerConfig).not.toHaveBeenCalled();
  });

  it('resolves an explicit destination with its own credentials, parameters, headers and prices', async () => {
    const input = options({
      provider: 'EU connection',
      model: 'learning-model',
      model_parameters: { temperature: 0.1, model: 'ignored-model' },
    });
    const result = await resolveBrainLearningModel(input);
    expect(providerConfig).toHaveBeenCalledWith({
      provider: 'EU connection',
      appConfig: input.req.config,
    });
    expect(getOptions).toHaveBeenCalledWith({
      req: input.req,
      endpoint: 'EU connection',
      model_parameters: { temperature: 0.1, model: 'learning-model' },
      db: input.db,
    });
    expect(result?.llmConfig).toMatchObject({
      model: 'learning-model',
      apiKey: 'synthetic-target-key',
      provider: Providers.OPENAI,
      configuration: {
        baseURL: 'https://target.test/v1',
        defaultHeaders: { 'x-conversation': 'conversation' },
      },
    });
    expect(result?.endpointTokenConfig).toBe(targetPricing);
    expect(JSON.stringify(result)).not.toContain('synthetic-primary-key');
  });

  it('disables only the learning resolver when memory.agent.enabled is false', async () => {
    expect(
      await resolveBrainLearningModel(
        options({ enabled: false, provider: 'Unused', model: 'unused' }),
      ),
    ).toBeNull();
    expect(providerConfig).not.toHaveBeenCalled();
  });

  it.each([
    { provider: 'Missing model' },
    { model: 'Missing provider' },
    { id: 'legacy-agent-id' },
  ])(
    'rejects explicit incomplete or unsupported agent configuration without falling back: %j',
    async (configured) => {
      await expect(resolveBrainLearningModel(options(configured))).rejects.toBeInstanceOf(
        BrainLearningConfigurationError,
      );
      expect(getOptions).not.toHaveBeenCalled();
    },
  );

  it('does not fall back or expose secrets when the selected provider fails', async () => {
    getOptions.mockRejectedValueOnce(new Error('synthetic-private-credential'));
    await expect(
      resolveBrainLearningModel(options({ provider: 'Target', model: 'learning-model' })),
    ).rejects.toThrow('Es wird kein Ersatzanbieter verwendet.');
    expect(getOptions).toHaveBeenCalledTimes(1);
  });

  it('honours the configured agent-provider allowlist', async () => {
    const input = options({ provider: 'Denied', model: 'learning-model' });
    input.req.config!.endpoints = { agents: { allowedProviders: ['Allowed'] } };
    await expect(resolveBrainLearningModel(input)).rejects.toThrow('nicht freigegeben');
    expect(getOptions).not.toHaveBeenCalled();
  });

  it('retains native provider transport guards and resolves its header carrier', async () => {
    const fetchOptions = { dispatcher: { synthetic: true } };
    getOptions.mockResolvedValueOnce({
      provider: Providers.ANTHROPIC,
      llmConfig: {
        model: 'learning-model',
        apiKey: 'synthetic-target-key',
        clientOptions: {
          fetchOptions,
          defaultHeaders: { 'x-conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        },
      },
      endpointTokenConfig: targetPricing,
    });
    const result = await resolveBrainLearningModel(
      options({ provider: 'Native endpoint', model: 'learning-model' }),
    );
    expect(result?.llmConfig.provider).toBe(Providers.ANTHROPIC);
    const native = result?.llmConfig as unknown as {
      clientOptions: { fetchOptions: unknown; defaultHeaders: object };
    };
    expect(native.clientOptions.fetchOptions).toBe(fetchOptions);
    expect(native.clientOptions.defaultHeaders).toEqual({ 'x-conversation': 'conversation' });
  });

  it.each([undefined, 'azure-instance'])(
    'normalizes Azure according to the resolved deployment: %s',
    async (instance) => {
      getOptions.mockResolvedValueOnce({
        llmConfig: { model: 'deployment', azureOpenAIApiInstanceName: instance },
      });
      const result = await resolveBrainLearningModel(
        options({ provider: 'azureOpenAI', model: 'deployment' }),
      );
      expect(result?.llmConfig.provider).toBe(instance ? Providers.AZURE : Providers.OPENAI);
    },
  );
});
