import { Types } from 'mongoose';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { AppConfig, IUser, IRole } from '@librechat/data-schemas';
import { createMailAssistantRuntime, mailAssistantConfigurationStatus } from './runtime';
import type { MailRuntimeDependencies } from './runtime';
jest.mock('~/middleware/usageCredit', () => ({
  assertUsageCredit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/utils/tokenizer', () => ({ countTokens: jest.fn().mockResolvedValue(100) }));
const owner = '64b123456789012345678901';
const baseEnv = {
  MAIL_ASSISTANT_ENABLED: 'true',
  MAIL_ASSISTANT_INSTANCE: 'cw01',
  MAIL_ASSISTANT_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  MAIL_ASSISTANT_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  MAIL_ASSISTANT_CLIENT_SECRET: 'fixture-only',
  MAIL_ASSISTANT_DATA_KEY: 'ab'.repeat(32),
  DOMAIN_SERVER: 'https://cowork.example',
};
function fixture() {
  let user: IUser | null = {
    _id: new Types.ObjectId(owner),
    id: owner,
    email: 'person@example.com',
    emailVerified: true,
    role: 'USER',
  } as IUser;
  let baseURL = 'https://api.eurouter.ai/api/v1';
  let specs: AppConfig['modelSpecs'] = {
    list: [
      {
        name: 'fixture-default',
        label: 'Test',
        default: true,
        preset: { endpoint: 'EuRouter', model: 'fixture-model' },
      },
    ],
  };
  let permitted = true;
  let banned = false;
  let auditFailure = false;
  const deps: MailRuntimeDependencies = {
    env: { ...baseEnv },
    collection: () => {
      throw Error('Database access not expected');
    },
    getUserById: async () => user,
    getRoleByName: async () =>
      ({
        permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: permitted } },
      }) as IRole,
    getAccessibleAgent: async () => null,
    getAppConfig: async () =>
      ({
        modelSpecs: specs,
        endpoints: { custom: [{ name: 'EuRouter', baseURL, apiKey: 'fixture-key' }] },
      }) as AppConfig,
    checkUserBan: async () => {
      if (banned) throw Error('banned');
    },
    audit: async () => {
      if (auditFailure) throw Error('audit');
      return {};
    },
    createTransaction: async () => undefined,
    balance: {
      getMultiplier: () => 1,
      findBalanceByUser: async () => null,
      createAutoRefillTransaction: async () => undefined,
    },
    fetch: async () => {
      throw Error('Network request not expected');
    },
  };
  return {
    deps,
    setSpecs: (value: AppConfig['modelSpecs']) => {
      specs = value;
    },
    setRoute: (route: string) => {
      baseURL = route;
    },
    ban: () => {
      banned = true;
    },
    deny: () => {
      permitted = false;
    },
    unverify: () => {
      user!.emailVerified = false;
    },
    remove: () => {
      user = null;
    },
    failAudit: () => {
      auditFailure = true;
    },
  };
}
describe('Mail assistant runtime boundaries', () => {
  it.each([{ MAIL_ASSISTANT_ENABLED: 'false' }, { MAIL_ASSISTANT_INSTANCE: 'cw02' }, {}])(
    'starts only under explicit CW01 activation %j',
    (override) => {
      const { deps } = fixture();
      deps.env = override;
      expect(createMailAssistantRuntime(deps)).toBeNull();
    },
  );
  it('checks approved configuration without network or mailbox reads', async () => {
    const f = fixture();
    expect(await createMailAssistantRuntime(f.deps)!.adapter.availability(owner)).toEqual({
      available: true,
      modelLabel: 'EuRouter · fixture-model · EU-Inferenz laut Anbieter',
      modelFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each([
    'https://api.eurouter.ai.evil.example/api/v1',
    'http://api.eurouter.ai/api/v1',
    'https://api.eurouter.ai/api/v1?next=evil',
    'user_provided',
  ])('rejects unapproved route %s without a fallback', async (route) => {
    const f = fixture();
    f.setRoute(route);
    expect((await createMailAssistantRuntime(f.deps)!.adapter.availability(owner)).available).toBe(
      false,
    );
  });
  it('uses the configured global route with an explicit region label and a different route fingerprint', async () => {
    const f = fixture();
    const runtime = createMailAssistantRuntime(f.deps)!;
    const previous = await runtime.adapter.availability(owner);
    f.setRoute('https://openrouter.ai/api/v1');
    const current = await runtime.adapter.availability(owner);
    expect(current.available).toBe(true);
    expect(current.modelLabel).toContain('Globale Verarbeitung; keine EU-Zusage');
    expect(current.modelFingerprint).not.toBe(previous.modelFingerprint);
  });
  it('refuses missing or ambiguous defaults instead of choosing a first card', async () => {
    const f = fixture();
    const runtime = createMailAssistantRuntime(f.deps)!;
    const card = {
      name: 'one',
      label: 'One',
      preset: { endpoint: 'EuRouter', model: 'fixture-model' },
    };
    f.setSpecs({ list: [card] });
    expect((await runtime.adapter.availability(owner)).available).toBe(false);
    f.setSpecs({
      list: [
        { ...card, default: true },
        { ...card, name: 'two', default: true },
      ],
    });
    expect((await runtime.adapter.availability(owner)).available).toBe(false);
    f.setSpecs({ list: [{ ...card, softDefault: true }] });
    expect((await runtime.adapter.availability(owner)).available).toBe(true);
  });
  it('resolves a default agent only through the native current-user ACL', async () => {
    const f = fixture();
    f.setSpecs({
      list: [
        {
          name: 'luna',
          label: 'Luna',
          default: true,
          preset: { endpoint: 'agents', agent_id: 'agent_luna' },
        },
      ],
    });
    const runtime = createMailAssistantRuntime(f.deps)!;
    expect((await runtime.adapter.availability(owner)).available).toBe(false);
    f.deps.getAccessibleAgent = jest
      .fn()
      .mockResolvedValue({ provider: 'EuRouter', model: 'fixture-agent-model' });
    expect((await runtime.adapter.availability(owner)).modelLabel).toContain('fixture-agent-model');
    expect(f.deps.getAccessibleAgent).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: owner }) }),
      'agent_luna',
    );
  });
  it('reports invalid private configuration without preventing the chat runtime from starting', () => {
    const f = fixture();
    f.deps.env!.MAIL_ASSISTANT_DATA_KEY = 'invalid';
    expect(mailAssistantConfigurationStatus(f.deps.env)).toEqual({
      enabled: true,
      configured: false,
      reason: expect.any(String),
    });
    expect(createMailAssistantRuntime(f.deps)).toBeNull();
    expect(mailAssistantConfigurationStatus(baseEnv)).toEqual({ enabled: true, configured: true });
  });
  it.each(['ban', 'deny', 'unverify', 'remove'] as const)(
    'reloads current user restrictions (%s)',
    async (change) => {
      const f = fixture();
      const runtime = createMailAssistantRuntime(f.deps)!;
      await runtime.adapter.authorize(owner);
      f[change]();
      await expect(runtime.adapter.authorize(owner)).rejects.toThrow();
    },
  );
  it('fails before mutation if durable audit is unavailable', async () => {
    const f = fixture();
    f.failAudit();
    await expect(
      createMailAssistantRuntime(f.deps)!.adapter.audit(owner, 'draft_requested'),
    ).rejects.toThrow();
  });
  it('uses only the explicit model, preserves privacy restrictions and accounts before returning a draft', async () => {
    const f = fixture();
    f.setRoute('https://openrouter.ai/api/v1');
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    f.deps.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  priority: 'normal',
                  action: 'reply',
                  summary: 'Anfrage',
                  reason: 'Antwort nötig',
                  questions: ['Interne Frage'],
                  draft: 'Guten Tag',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }),
      );
    };
    f.deps.createTransaction = jest.fn().mockResolvedValue(undefined);
    const runtime = createMailAssistantRuntime(f.deps)!;
    const result = await runtime.adapter.analyze(owner, [], async () => undefined);
    expect(result.draft).toBe('Guten Tag');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].body.model).toBe('fixture-model');
    expect(calls[0].body.provider).toEqual({ allow_fallbacks: false, data_collection: 'deny' });
    expect(calls[0].body).not.toHaveProperty('tools');
    expect(f.deps.createTransaction).toHaveBeenCalledTimes(2);
    f.deps.createTransaction = jest.fn().mockRejectedValue(new Error('accounting unavailable'));
    await expect(runtime.adapter.analyze(owner, [], async () => undefined)).rejects.toThrow(
      'accounting',
    );
  });
  it('refuses a changed default route at the final model-request boundary', async () => {
    const f = fixture();
    f.deps.fetch = jest.fn();
    const runtime = createMailAssistantRuntime(f.deps)!;
    await expect(
      runtime.adapter.analyze(owner, [], async () => {
        f.setRoute('https://openrouter.ai/api/v1');
      }),
    ).rejects.toThrow('geändert');
    expect(f.deps.fetch).not.toHaveBeenCalled();
  });
  it('preserves the exact-case native direct gateway and binds its policy snapshot to the model request', async () => {
    const f = fixture();
    f.deps.getAppConfig = async () =>
      ({
        modelSpecs: {
          list: [
            {
              name: 'cowork-luna',
              label: 'Luna',
              default: true,
              preset: { endpoint: 'OpenRouter', model: 'openai/gpt-5.6-luna' },
            },
          ],
        },
        endpoints: {
          custom: [
            { name: 'Openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'must-not-use' },
            {
              name: 'OpenRouter',
              baseURL: 'http://mcp-gateway:3020/router/v1/direct',
              apiKey: 'internal-docker-net',
            },
          ],
        },
      }) as AppConfig;
    const calls: { url: string; init: Parameters<typeof fetch>[1] }[] = [];
    const fingerprint = 'ab'.repeat(32);
    let upstream = 'https://openrouter.ai/api/v1';
    f.deps.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/diagnostics?'))
        return new Response(
          JSON.stringify({
            profile: 'direct',
            models: { default: 'openai/gpt-5.6-luna' },
            policyFingerprint: fingerprint,
            upstream: { baseURL: upstream, openrouterBody: true },
            hasUpstreamKey: true,
          }),
        );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  priority: 'normal',
                  action: 'reply',
                  summary: 'Anfrage',
                  reason: 'Antwort nötig',
                  questions: [],
                  draft: 'Guten Tag',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }),
      );
    };
    const runtime = createMailAssistantRuntime(f.deps)!;
    expect((await runtime.adapter.availability(owner)).modelLabel).toContain(
      'über MCP-Gateway · Globale Verarbeitung',
    );
    await runtime.adapter.analyze(owner, [], async () => undefined);
    const post = calls.find((call) => call.init?.method === 'POST')!;
    expect(post.url).toBe('http://mcp-gateway:3020/router/v1/direct/chat/completions');
    expect(post.init?.headers).toMatchObject({
      Authorization: 'Bearer internal-docker-net',
      'X-EUCowork-Mail-Assistant': 'true',
      'X-EUCowork-Route-Fingerprint': fingerprint,
      'X-EUCowork-User-Id': owner,
    });
    expect(JSON.parse(String(post.init?.body)).model).toBe('openai/gpt-5.6-luna');
    expect(calls.some((call) => call.url.startsWith('https://'))).toBe(false);
    upstream = 'https://unknown-provider.example/api/v1';
    expect((await runtime.adapter.availability(owner)).available).toBe(false);
  });
  it('does not send mail content when paused during the final gateway diagnostics request', async () => {
    const f = fixture();
    f.setRoute('http://mcp-gateway:3020/router/v1/direct');
    let paused = false;
    let diagnostics = 0;
    const calls: string[] = [];
    f.deps.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes('/diagnostics?')) throw Error('Mail content must not be sent');
      diagnostics++;
      if (diagnostics === 2) paused = true;
      return new Response(
        JSON.stringify({
          profile: 'direct',
          models: { default: 'fixture-model' },
          policyFingerprint: 'ab'.repeat(32),
          upstream: { baseURL: 'https://openrouter.ai/api/v1', openrouterBody: true },
          hasUpstreamKey: true,
        }),
      );
    };
    const runtime = createMailAssistantRuntime(f.deps)!;
    await expect(
      runtime.adapter.analyze(owner, [], async () => {
        if (paused) throw Error('Die Verarbeitung wurde pausiert.');
      }),
    ).rejects.toThrow('pausiert');
    expect(diagnostics).toBe(2);
    expect(calls.every((url) => url.includes('/diagnostics?'))).toBe(true);
  });
});
