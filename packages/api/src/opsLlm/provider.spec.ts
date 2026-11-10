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
const automaticConfig = () =>
  readOpsConfig({ KISUNO_OPS_TENANT_ID: 'cwv01', KISUNO_OPS_INTERNAL_ENABLED: 'true' });
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
type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
function fetchMock(implementation: FetchCall) {
  return Object.assign(
    jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(implementation),
    {
      preconnect: jest.fn<ReturnType<typeof fetch.preconnect>, Parameters<typeof fetch.preconnect>>(
        () => undefined,
      ),
    },
  );
}
const make = (
  request = fetchMock(async () => new Response(JSON.stringify(answer()))),
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
  test('works without attestation and enforces ZDR request controls, no fallback and no tools', async () => {
    const { provider, request } = make();
    const automatic = automaticConfig();
    expect(automatic.policy).toBeUndefined();
    const result = await provider.complete(automatic, input(), new AbortController().signal);
    expect(result.model).toBe('openai/test');
    expect(result.usage.total_tokens).toBe(15);
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
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
  test('an explicitly configured expired policy still prevents sending content', async () => {
    const { provider, request } = make();
    await expect(
      provider.complete(
        { ...config(), policy: { ...config().policy!, expiresAt: '2026-11-02T00:00:00Z' } },
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test('automatic resolution follows the current central model and credential without an attestation', async () => {
    const value = app();
    const request = fetchMock(
      async () =>
        new Response(
          JSON.stringify({ ...answer(), model: value.modelSpecs!.list![0].preset!.model }),
        ),
    );
    const { provider } = make(request, value);
    await provider.complete(automaticConfig(), input(), new AbortController().signal);
    value.modelSpecs!.list![0].preset!.model = 'openai/next';
    value.endpoints!.custom![0].apiKey = 'next-synthetic-provider-key';
    await provider.complete(automaticConfig(), input(), new AbortController().signal);
    expect(JSON.parse(request.mock.calls[1][1]!.body as string).model).toBe('openai/next');
    expect(request.mock.calls[1][1]!.headers).toMatchObject({
      Authorization: 'Bearer next-synthetic-provider-key',
    });
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'model_not_verified' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  test.each([
    'https://api.eurouter.ai/api/v1',
    'https://api.tensorx.ai/v1',
    'https://untrusted.invalid/api/v1',
    'https://openrouter.ai/api/v1/other',
    'http://mcp-gateway:3020/router/v1',
  ])('automatic mode does not expand the endpoint allowlist to %s', async (baseURL) => {
    const value = app();
    value.endpoints!.custom![0].baseURL = baseURL;
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(automaticConfig(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'provider_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test.each([
    'eu-auto',
    'openrouter/auto',
    'openai/test:online',
    'model with spaces',
    '../model',
    '',
  ])('automatic mode still refuses invalid or automatic model %s', async (model) => {
    const value = app();
    value.modelSpecs!.list![0].preset!.model = model;
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(automaticConfig(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'model_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test('an explicitly configured malformed policy is not silently ignored', () => {
    expect(() => readOpsConfig({ KISUNO_OPS_PROVIDER_POLICY_JSON: '{invalid' })).toThrow();
  });
  test('an optional policy may still disable JSON mode', async () => {
    const { provider, request } = make();
    await expect(
      provider.complete(
        { ...config(), policy: { ...config().policy!, jsonObject: false } },
        { ...input(), response_format: { type: 'json_object' } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'json_not_supported' });
    expect(request).not.toHaveBeenCalled();
  });
  test('does not follow central default changes or unsupported endpoint parameters', async () => {
    const value = app();
    value.modelSpecs!.list![0].preset!.model = 'eu-auto';
    const { provider, request } = make(undefined, value);
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'model_not_verified' });
    expect(request).not.toHaveBeenCalled();
  });
  test.each(['not json', '[]', 'null', '{"truncated":'])(
    'invalid JSON is never returned as JSON mode',
    async (content) => {
      const { provider } = make(
        fetchMock(async () => new Response(JSON.stringify(answer(content)))),
      );
      await expect(
        provider.complete(
          automaticConfig(),
          { ...input(), response_format: { type: 'json_object' } },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_json_response' });
    },
  );
  test('valid JSON keeps escaping unchanged', async () => {
    const content = JSON.stringify({ text: 'Name "quoted"\\path\nnext' });
    const { provider } = make(fetchMock(async () => new Response(JSON.stringify(answer(content)))));
    expect(
      (
        await provider.complete(
          automaticConfig(),
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
    const request = fetchMock(
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
    const request = fetchMock(async (_url: string | URL | Request, options?: RequestInit) => {
      options?.signal?.throwIfAborted();
      return new Response('{}');
    });
    await expect(
      make(request).provider.complete(config(), input(), controller.signal),
    ).rejects.toThrow();
    const limited = make(
      fetchMock(async () => new Response('private upstream body', { status: 429 })),
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
        make(fetchMock(async () => new Response(JSON.stringify(value)))).provider.complete(
          config(),
          input(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_upstream_response' });
    }
    await expect(
      make(fetchMock(async () => new Response('x'.repeat(1048577)))).provider.complete(
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
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).provider).toMatchObject({
      only: ['approved'],
      allow_fallbacks: false,
      zdr: true,
    });
  });
  test('implicit online browsing is refused even with operator policy', async () => {
    const value = app();
    value.modelSpecs!.list![0].preset!.model = 'openai/test:online';
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
    const request = fetchMock(
      async (url: string | URL | Request) =>
        new Response(JSON.stringify(String(url).includes('/diagnostics') ? diagnostics : answer())),
    );
    const provider = make(request, value).provider;
    await provider.complete(config(), input(), new AbortController().signal);
    expect(request.mock.calls[1][1]!.headers).toMatchObject({
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
  test('automatic gateway routing uses fresh credential-bound fingerprints without an attestation', async () => {
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
        credentialFingerprint: 'b'.repeat(64),
        policyFingerprint: 'c'.repeat(64),
      },
    };
    const request = fetchMock(
      async (url: string | URL | Request) =>
        new Response(JSON.stringify(String(url).includes('/diagnostics') ? diagnostics : answer())),
    );
    const provider = make(request, value).provider;
    const automatic = automaticConfig();
    await provider.complete(automatic, input(), new AbortController().signal);
    expect(request.mock.calls[1][1]!.headers).toMatchObject({
      'X-EUCowork-OPS-Text': 'true',
      'X-EUCowork-Route-Fingerprint': 'c'.repeat(64),
    });
    diagnostics.opsText.credentialFingerprint = 'd'.repeat(64);
    diagnostics.opsText.policyFingerprint = 'e'.repeat(64);
    await provider.complete(automatic, input(), new AbortController().signal);
    expect(request.mock.calls[3][1]!.headers).toMatchObject({
      'X-EUCowork-Route-Fingerprint': 'e'.repeat(64),
    });
    expect(automatic.policy).toBeUndefined();
    for (const changed of [
      { ...diagnostics, profile: 'default' },
      { ...diagnostics, hasUpstreamKey: false },
      { ...diagnostics, models: { default: 'different/model' } },
      { ...diagnostics, upstream: { baseURL: 'https://untrusted.invalid', openrouterBody: true } },
      { ...diagnostics, upstream: { ...diagnostics.upstream, openrouterBody: false } },
      { ...diagnostics, opsText: { ...diagnostics.opsText, policyFingerprint: '' } },
      { ...diagnostics, opsText: { ...diagnostics.opsText, credentialFingerprint: '' } },
      { ...diagnostics, opsText: { ...diagnostics.opsText, noContentLogging: false } },
    ]) {
      const rejected = fetchMock(async () => new Response(JSON.stringify(changed)));
      await expect(
        make(rejected, value).provider.complete(automatic, input(), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'gateway_not_verified' });
      expect(rejected).toHaveBeenCalledTimes(1);
    }
  });
  test('provider cannot silently answer with a different model', async () => {
    const { provider } = make(
      fetchMock(
        async () => new Response(JSON.stringify({ ...answer(), model: 'different/model' })),
      ),
    );
    await expect(
      provider.complete(config(), input(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unexpected_model' });
  });
});
