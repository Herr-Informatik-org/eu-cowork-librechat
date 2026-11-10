import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getProviderConfig } from './providers';
import { createPrivacyModelFetch, isProtectedModelEndpoint, PrivacyRouteError } from './privacy';

const baseURL = 'http://privacy-proxy:3040/r/openrouter-direct/v1';
const token = 'synthetic-route-token';
const provider = {
  name: 'OpenRouter',
  baseURL,
  apiKey: '${OPENROUTER_API_KEY}',
  models: { default: ['test/model'], fetch: false },
  headers: {
    'X-EUCowork-Privacy-Key': '${PRIVACY_ROUTE_TOKEN}',
    'X-EUCowork-User-Id': '{{LIBRECHAT_USER_ID}}',
    'X-EUCowork-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
  },
};

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    PRIVACY_REQUIRED: 'true',
    PRIVACY_ROUTE_TOKEN: token,
  });
});

it('allows the configured route and denies native, direct and incomplete endpoint definitions', () => {
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: { custom: [provider] },
  };
  expect(
    getProviderConfig({ provider: 'OpenRouter', appConfig: config }).customEndpointConfig?.baseURL,
  ).toBe(baseURL);
  expect(() => getProviderConfig({ provider: 'openAI', appConfig: config })).toThrow(
    PrivacyRouteError,
  );
  for (const change of [
    { baseURL: 'https://inference.example.test/v1' },
    { directEndpoint: true },
    { provider: EModelEndpoint.anthropic as const },
    { headers: {} },
  ]) {
    expect(isProtectedModelEndpoint({ ...provider, ...change })).toBe(false);
  }
  delete process.env.PRIVACY_ROUTE_TOKEN;
  expect(() => getProviderConfig({ provider: 'OpenRouter', appConfig: config })).toThrow(
    PrivacyRouteError,
  );
});

it('checks the real method, URL and resolved token before forwarding a request', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fixture'));
  const transport = createPrivacyModelFetch(baseURL);
  const headers = { 'X-EUCowork-Privacy-Key': token };
  await expect(
    transport('https://inference.example.test/v1/chat/completions', { method: 'POST', headers }),
  ).rejects.toThrow(PrivacyRouteError);
  await expect(transport(`${baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow(
    PrivacyRouteError,
  );
  await expect(transport(`${baseURL}/responses`, { method: 'POST', headers })).rejects.toThrow(
    PrivacyRouteError,
  );
  await expect(transport(`${baseURL}/chat/completions`, { headers })).rejects.toThrow(
    PrivacyRouteError,
  );
  expect(network).not.toHaveBeenCalled();
  const request = new Request(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  await expect(transport(request, { redirect: 'follow' })).resolves.toBeInstanceOf(Response);
  expect(network).toHaveBeenCalledWith(request, expect.objectContaining({ redirect: 'error' }));
});
