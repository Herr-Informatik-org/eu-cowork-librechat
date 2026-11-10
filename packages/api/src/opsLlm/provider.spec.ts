jest.mock('~/admin/secrets', () => ({
  resolveCustomEndpointSecrets: (value: object) => value,
  resolveConfigSecret: (value: string) => value,
}));
import type { AppConfig } from '@librechat/data-schemas';
import { createOpsProvider } from './provider';
import { createHash } from 'node:crypto';
import { completionSchema, readOpsConfig, assertEnabled } from './config';
const now = Date.parse('2026-11-10T00:00:00Z');
const policy = {
  baseURL: 'https://openrouter.ai/api/v1',
  model: 'openai/test',
  noRetention: true,
  credentialFingerprint: createHash('sha256').update('test-provider-not-a-secret').digest('hex'),
  jsonObject: true,
  reviewedAt: '2026-11-01T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
  reference: 'Verified provider contract',
};
const config = () =>
  readOpsConfig({
    KISUNO_OPS_TENANT_ID: 'cwv01',
    KISUNO_OPS_INTERNAL_ENABLED: 'true',
    KISUNO_OPS_PROVIDER_POLICY_JSON: JSON.stringify(policy),
  });
const app = () =>
  ({
    modelSpecs: {
      list: [
        {
          name: 'default',
          default: true,
          preset: { endpoint: 'OpenRouter', model: 'openai/test' },
        },
      ],
    },
    endpoints: {
      custom: [
        {
          name: 'OpenRouter',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'test-provider-not-a-secret',
        },
      ],
    },
  }) as AppConfig;
const input = () =>
  completionSchema.parse({
    model: 'kisuno-default',
    messages: [{ role: 'user', content: 'Test' }],
  });
const answer = (content = '{"ok":true}') => ({
  model: 'openai/test',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const make = (
  request = jest.fn(async () => new Response(JSON.stringify(answer()))),
  value = app(),
) => ({
  request,
  provider: createOpsProvider(
    { getCentralConfig: async () => value, getCentralAgent: async () => null, fetch: request },
    () => now,
  ),
});
describe('OPS strict text provider', () => {
  test.each([{}, { KISUNO_OPS_INTERNAL_ENABLED: 'true', KISUNO_OPS_TENANT_ID: 'cwv02' }])(
    'fails closed outside CWV01',
    (env) => expect(() => assertEnabled(readOpsConfig(env))).toThrow(),
  );
  test.each([
    { tools: [] },
    { stream: true },
    { model: 'other' },
    { response_format: { type: 'json_schema' } },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
    { messages: [{ role: 'tool', content: 'x' }] },
    { max_tokens: 1, max_completion_tokens: 1 },
  ])('rejects unsupported input %j', (extra) =>
    expect(completionSchema.safeParse({ ...input(), ...extra }).success).toBe(false),
  );
  test('enforces ZDR, no retention, no fallback, no tools, actual model and usage', async () => {
    const { provider, request } = make();
    const result = await provider.complete(config(), input(), new AbortController().signal);
    expect(result.model).toBe('openai/test');
    expect(result.usage.total_tokens).toBe(15);
    const body = JSON.parse(request.mock.calls[0][1].body as string);
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBe(false);
  });
  test('missing or expired policy never sends content', async () => {
    const { provider, request } = make();
    await expect(
      provider.complete({ ...config(), policy: undefined }, input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_not_verified' });
    await expect(
      provider.complete(
        { ...config(), policy: { ...config().policy!, expiresAt: '2026-11-02T00:00:00Z' } },
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test('does not follow central default changes or unsupported endpoint parameters', async () => {
    const value = app();
    value.modelSpecs!.list[0].preset.model = 'eu-auto';
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'model_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test.each(['not json', '[]', 'null', '{"truncated":'])(
    'invalid JSON is never returned as JSON mode',
    async (content) => {
      const { provider } = make(jest.fn(async () => new Response(JSON.stringify(answer(content)))));
      await expect(
        provider.complete(
          config(),
          { ...input(), response_format: { type: 'json_object' } },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_json_response' });
    },
  );
  test('valid JSON keeps escaping unchanged', async () => {
    const content = JSON.stringify({ text: 'Name "quoted"\\path\nnext' });
    const { provider } = make(jest.fn(async () => new Response(JSON.stringify(answer(content)))));
    expect(
      (
        await provider.complete(
          config(),
          { ...input(), response_format: { type: 'json_object' } },
          new AbortController().signal,
        )
      ).text,
    ).toBe(content);
  });
  test('enforces input/output bounds before provider call', async () => {
    const { provider, request } = make();
    await expect(
      provider.complete(
        config(),
        { ...input(), messages: [{ role: 'user', content: 'x'.repeat(33000) }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'input_limit_exceeded' });
    await expect(
      provider.complete(
        { ...config(), limits: { ...config().limits, outputTokens: 128 } },
        { ...input(), max_tokens: 129 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'output_limit_exceeded' });
    expect(request).not.toHaveBeenCalled();
  });
  test('gateway requires exact protected OPS capability and upstream policy', async () => {
    const value = app();
    value.endpoints!.custom![0].baseURL = 'http://mcp-gateway:3020/router/v1/direct';
    const request = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: 'direct',
            models: { default: 'openai/test' },
            policyFingerprint: 'a'.repeat(64),
            hasUpstreamKey: true,
            upstream: { baseURL: policy.baseURL, openrouterBody: true },
          }),
        ),
    );
    await expect(
      make(request, value).provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'gateway_not_verified' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('forwards abort signal and rejects provider errors without body disclosure', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = jest.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      options?.signal?.throwIfAborted();
      return new Response('{}');
    });
    await expect(
      make(request).provider.complete(config(), input(), controller.signal),
    ).rejects.toThrow();
    const limited = make(
      jest.fn(async () => new Response('private upstream body', { status: 429 })),
    );
    await expect(
      limited.provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ status: 429, retryAfter: 30 });
  });
  test('rejects hidden tool calls, missing usage and oversized output', async () => {
    for (const value of [
      { ...answer(), usage: undefined },
      {
        ...answer(),
        choices: [
          { message: { role: 'assistant', content: 'x', tool_calls: [] }, finish_reason: 'stop' },
        ],
      },
    ]) {
      await expect(
        make(jest.fn(async () => new Response(JSON.stringify(value)))).provider.complete(
          config(),
          input(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_upstream_response' });
    }
    await expect(
      make(jest.fn(async () => new Response('x'.repeat(1048577)))).provider.complete(
        config(),
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_upstream_response' });
  });
  test('retains narrower administrator provider restrictions', async () => {
    const value = app();
    value.endpoints!.custom![0].addParams = {
      provider: { only: ['approved'], allow_fallbacks: true },
    };
    const { provider, request } = make(undefined, value);
    await provider.complete(config(), input(), new AbortController().signal);
    expect(JSON.parse(request.mock.calls[0][1].body as string).provider).toMatchObject({
      only: ['approved'],
      allow_fallbacks: false,
      zdr: true,
    });
  });
  test('implicit online browsing is refused even with operator policy', async () => {
    const value = app();
    value.modelSpecs!.list[0].preset.model = 'openai/test:online';
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(
        { ...config(), policy: { ...config().policy!, model: 'openai/test:online' } },
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'model_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test('a changed provider credential invalidates the no-retention attestation', async () => {
    const value = app();
    value.endpoints!.custom![0].apiKey = 'different-test-account';
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test('gateway uses only credential-bound OPS fingerprint and rejects account change', async () => {
    const value = app();
    value.endpoints!.custom![0].baseURL = 'http://mcp-gateway:3020/router/v1/direct';
    const diagnostics = {
      profile: 'direct',
      models: { default: 'openai/test' },
      policyFingerprint: 'a'.repeat(64),
      hasUpstreamKey: true,
      upstream: { baseURL: policy.baseURL, openrouterBody: true },
      opsText: {
        version: 1,
        noRetention: true,
        jsonObject: true,
        noContentLogging: true,
        credentialFingerprint: policy.credentialFingerprint,
        policyFingerprint: 'b'.repeat(64),
      },
    };
    const request = jest.fn(
      async (url: string | URL | Request) =>
        new Response(JSON.stringify(String(url).includes('/diagnostics') ? diagnostics : answer())),
    );
    const provider = make(request, value).provider;
    await provider.complete(config(), input(), new AbortController().signal);
    expect(request.mock.calls[1][1].headers).toMatchObject({
      'X-EUCowork-OPS-Text': 'true',
      'X-EUCowork-Route-Fingerprint': 'b'.repeat(64),
    });
    request.mockClear();
    diagnostics.opsText.credentialFingerprint = 'c'.repeat(64);
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'gateway_not_verified' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('provider cannot silently answer with a different model', async () => {
    const { provider } = make(
      jest.fn(async () => new Response(JSON.stringify({ ...answer(), model: 'different/model' }))),
    );
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unexpected_model' });
  });
});
