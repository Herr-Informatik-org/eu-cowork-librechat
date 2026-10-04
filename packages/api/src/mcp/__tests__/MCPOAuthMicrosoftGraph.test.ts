import { Keyv } from 'keyv';
import { MCPOptionsSchema } from 'librechat-data-provider';
import type { MCPOptions, OAuthResourceMode } from 'librechat-data-provider';
import type { MCPOAuthFlowMetadata, MCPOAuthTokens } from '~/mcp/oauth';
import { InMemoryTokenStore } from './helpers/oauthTestServer';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { FlowStateManager } from '~/flow/manager';
import { processMCPEnv } from '~/utils/env';
import { MCPOAuthHandler, MCPTokenStorage } from '~/mcp/oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  getTenantId: jest.fn(),
  tenantStorage: { getStore: jest.fn() },
  encryptV2: jest.fn(async (value: string) => `enc:${value}`),
  decryptV2: jest.fn(async (value: string) => value.replace(/^enc:/, '')),
}));

const SERVER_URL = 'http://ms365-mcp:3000/mcp';
const SERVER_NAME = 'sharepoint';
const USER_ID = 'graph-test-user';
const ENTRA_BASE =
  'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0';
const DCR_BASE = 'https://oauth.example.test';
const RESOURCE_METADATA_URL = 'http://ms365-mcp:3000/.well-known/oauth-protected-resource';
const ALLOWED_DOMAINS = ['http://ms365-mcp:3000', 'https://login.microsoftonline.com', DCR_BASE];
const SCOPE = 'openid profile offline_access https://graph.microsoft.com/User.Read Sites.Read.All';
const GRAPH_CONFIG: NonNullable<MCPOptions['oauth']> = {
  resource_mode: 'microsoft_graph',
  client_id: 'configured-client',
  authorization_url: `${ENTRA_BASE}/authorize`,
  token_url: `${ENTRA_BASE}/token`,
  scope: SCOPE,
};

type RefreshMetadata = Parameters<typeof MCPOAuthHandler.refreshOAuthTokens>[1];

class RefreshFactory extends MCPConnectionFactory {
  constructor(config?: MCPOptions['oauth']) {
    super({
      serverName: SERVER_NAME,
      serverConfig: { type: 'streamable-http', url: SERVER_URL, oauth: config },
      allowedDomains: ALLOWED_DOMAINS,
      dbSourced: true,
    });
  }

  refresh = this.createRefreshTokensFunction();
}

function storedMetadata(flow: MCPOAuthFlowMetadata) {
  return MCPOAuthHandler.buildStoredClientMetadata(
    flow.metadata,
    flow.resourceMetadata,
    flow.serverUrl,
    flow.clientSource,
    flow.resourceMode,
  )!;
}

function refreshMetadata(flow: MCPOAuthFlowMetadata): RefreshMetadata {
  const stored = storedMetadata(flow);
  return {
    serverName: SERVER_NAME,
    serverUrl: flow.serverUrl,
    clientInfo: flow.clientInfo,
    storedServerUrl: stored.server_url,
    storedTokenEndpoint: stored.token_endpoint,
    storedAuthorizationEndpoint: stored.authorization_endpoint,
    storedAuthMethods: stored.token_endpoint_auth_methods_supported,
    clientSource: stored.client_source,
    resource: stored.resource,
    resourceMode: stored.resource_mode,
  };
}

describe('Microsoft Graph OAuth resource policy with real MCP SDK functions', () => {
  let flowManager: FlowStateManager<MCPOAuthTokens>;
  let tokenRequests: { url: string; body: URLSearchParams; headers: Headers }[];
  let prmResource: string;
  let dcr: boolean;

  beforeEach(() => {
    flowManager = new FlowStateManager<MCPOAuthTokens>(new Keyv(), { ttl: 30000, ci: true });
    tokenRequests = [];
    prmResource = SERVER_URL;
    dcr = false;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === SERVER_URL) {
        return new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` },
        });
      }
      if (url === RESOURCE_METADATA_URL) {
        return Response.json({
          resource: prmResource,
          authorization_servers: [dcr ? DCR_BASE : 'http://ms365-mcp:3000'],
        });
      }
      if (url.startsWith(DCR_BASE) && url.includes('/.well-known/')) {
        return Response.json({
          issuer: DCR_BASE,
          authorization_endpoint: `${DCR_BASE}/authorize`,
          token_endpoint: `${DCR_BASE}/token`,
          registration_endpoint: `${DCR_BASE}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${DCR_BASE}/register`) {
        return Response.json({
          ...JSON.parse(String(init?.body)),
          client_id: 'dynamic-client',
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.endsWith('/token') && init?.method === 'POST') {
        const body = new URLSearchParams(String(init.body));
        tokenRequests.push({ url, body, headers: new Headers(init.headers) });
        if (url === GRAPH_CONFIG.token_url && body.has('resource')) {
          return Response.json(
            {
              error: 'invalid_target',
              error_description: 'invalid_target: Entra v2 rejects the MCP resource',
            },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: `access-${tokenRequests.length}`,
          refresh_token: `refresh-${tokenRequests.length}`,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`Unexpected external HTTP request: ${url}`);
    });
  });

  async function initiate(config: MCPOptions['oauth'] = GRAPH_CONFIG) {
    return MCPOAuthHandler.initiateOAuthFlow(
      SERVER_NAME,
      SERVER_URL,
      USER_ID,
      {},
      config,
      ALLOWED_DOMAINS,
    );
  }

  async function exchange(flow: MCPOAuthFlowMetadata, flowId = 'test-flow') {
    await flowManager.initFlow(flowId, 'mcp_oauth', flow);
    return MCPOAuthHandler.completeOAuthFlow(flowId, 'authorization-code', flowManager, {});
  }

  it.each([undefined, 'mcp'] as const)(
    'reproduces invalid_target with default/resource_mode=%s and the internal MCP resource',
    async (resourceMode) => {
      const config = { ...GRAPH_CONFIG, resource_mode: resourceMode };
      const { authorizationUrl, flowMetadata } = await initiate(config);
      expect(new URL(authorizationUrl).searchParams.get('resource')).toBe(SERVER_URL);
      await expect(exchange(flowMetadata)).rejects.toThrow('invalid_target');
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token',
          refreshMetadata(flowMetadata),
          {},
          config,
          ALLOWED_DOMAINS,
        ),
      ).rejects.toThrow('invalid_target');
      expect(tokenRequests.map(({ body }) => body.get('resource'))).toEqual([
        SERVER_URL,
        SERVER_URL,
      ]);
    },
  );

  it.each(['none', 'client_secret_post', 'client_secret_basic'] as const)(
    'omits resource for %s authorization, exchange, and a stored refresh through the factory',
    async (authMethod) => {
      const config = {
        ...GRAPH_CONFIG,
        ...(authMethod !== 'none' && { client_secret: 'test-only-client-secret' }),
        token_endpoint_auth_methods_supported: [authMethod],
      };
      const { authorizationUrl, flowMetadata } = await initiate(config);
      const auth = new URL(authorizationUrl);
      expect(auth.searchParams.has('resource')).toBe(false);
      expect(auth.searchParams.get('scope')).toBe(SCOPE);
      expect(auth.searchParams.get('state')).toBe(flowMetadata.state);
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(flowMetadata.resourceMode).toBe('microsoft_graph');
      expect(flowMetadata.resourceMetadata?.resource).toBe(SERVER_URL);

      const tokens = await exchange(flowMetadata);
      const store = new InMemoryTokenStore();
      await MCPTokenStorage.storeTokens({
        userId: USER_ID,
        serverName: SERVER_NAME,
        tokens,
        clientInfo: flowMetadata.clientInfo,
        metadata: storedMetadata(flowMetadata),
        createToken: store.createToken,
        updateToken: store.updateToken,
        findToken: store.findToken,
      });
      const factory = new RefreshFactory(config);
      await expect(
        MCPTokenStorage.forceRefreshTokens({
          userId: USER_ID,
          serverName: SERVER_NAME,
          findToken: store.findToken,
          createToken: store.createToken,
          updateToken: store.updateToken,
          refreshTokens: factory.refresh,
        }),
      ).resolves.toEqual(expect.objectContaining({ access_token: 'access-2' }));
      expect(tokenRequests.map(({ body }) => body.has('resource'))).toEqual([false, false]);
      expect(tokenRequests.map(({ body }) => body.get('grant_type'))).toEqual([
        'authorization_code',
        'refresh_token',
      ]);
      expect(tokenRequests[1].body.get('scope')).toBe(SCOPE);
      for (const request of tokenRequests) {
        if (authMethod === 'client_secret_basic') {
          expect(request.body.has('client_id')).toBe(false);
          expect(request.body.has('client_secret')).toBe(false);
          expect(request.headers.get('Authorization')).toBe(
            `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`,
          );
        } else {
          expect(request.body.get('client_id')).toBe(config.client_id);
          expect(request.body.get('client_secret')).toBe(config.client_secret ?? null);
          expect(request.headers.has('Authorization')).toBe(false);
        }
      }
      const persisted = await MCPTokenStorage.getClientInfoAndMetadata({
        userId: USER_ID,
        serverName: SERVER_NAME,
        findToken: store.findToken,
      });
      expect(persisted?.clientMetadata).toEqual(
        expect.objectContaining({
          server_url: SERVER_URL,
          resource: SERVER_URL,
          resource_mode: 'microsoft_graph',
          authorization_endpoint: GRAPH_CONFIG.authorization_url,
        }),
      );
    },
  );

  it('resolves the trusted YAML scope environment reference before authorization and refresh', async () => {
    const previousScope = process.env.MS365_OFFICE_OAUTH_SCOPE;
    process.env.MS365_OFFICE_OAUTH_SCOPE = SCOPE;
    try {
      const parsed = MCPOptionsSchema.parse({
        type: 'streamable-http',
        url: SERVER_URL,
        oauth: { ...GRAPH_CONFIG, scope: '${MS365_OFFICE_OAUTH_SCOPE}' },
      });
      expect(parsed.oauth?.scope).toBe('${MS365_OFFICE_OAUTH_SCOPE}');
      const runtime = processMCPEnv({ options: parsed });
      expect(runtime.oauth?.scope).toBe(SCOPE);
      const { authorizationUrl, flowMetadata } = await initiate(runtime.oauth);
      expect(new URL(authorizationUrl).searchParams.get('scope')).toBe(SCOPE);
      await exchange(flowMetadata);
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token',
        refreshMetadata(flowMetadata),
        {},
        runtime.oauth,
        ALLOWED_DOMAINS,
      );
      expect(tokenRequests[1].body.get('scope')).toBe(SCOPE);
      expect(tokenRequests.every(({ body }) => !body.has('resource'))).toBe(true);
    } finally {
      if (previousScope === undefined) {
        delete process.env.MS365_OFFICE_OAUTH_SCOPE;
      } else {
        process.env.MS365_OFFICE_OAUTH_SCOPE = previousScope;
      }
    }
  });

  it('preserves the MCP resource in normal discovery, dynamic registration, and all grants', async () => {
    dcr = true;
    const { authorizationUrl, flowMetadata } = await initiate({ scope: 'read' });
    expect(flowMetadata.clientSource).toBe('dynamic');
    expect(new URL(authorizationUrl).searchParams.get('resource')).toBe(SERVER_URL);
    await exchange(flowMetadata);
    await MCPOAuthHandler.refreshOAuthTokens(
      'refresh-token',
      refreshMetadata(flowMetadata),
      {},
      undefined,
      ALLOWED_DOMAINS,
    );
    expect(tokenRequests.map(({ body }) => body.get('resource'))).toEqual([SERVER_URL, SERVER_URL]);
  });

  it.each(['mcp', 'microsoft_graph'] as OAuthResourceMode[])(
    'requires reauthorization when the stored %s mode changes',
    async (resourceMode) => {
      const config = { ...GRAPH_CONFIG, resource_mode: resourceMode };
      const { flowMetadata } = await initiate(config);
      const changed = {
        ...GRAPH_CONFIG,
        resource_mode: resourceMode === 'mcp' ? ('microsoft_graph' as const) : ('mcp' as const),
      };
      expect(() =>
        MCPOAuthHandler.assertStoredClientBinding(
          SERVER_NAME,
          SERVER_URL,
          flowMetadata.clientInfo,
          storedMetadata(flowMetadata),
          changed,
        ),
      ).toThrow(/Ressourcenmodus/);
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token',
          refreshMetadata(flowMetadata),
          {},
          changed,
          ALLOWED_DOMAINS,
        ),
      ).rejects.toThrow(/Ressourcenmodus/);
      expect(tokenRequests).toHaveLength(0);
    },
  );

  it.each([
    'storedServerUrl',
    'storedTokenEndpoint',
    'storedAuthorizationEndpoint',
    'clientInfo',
    'clientSource',
    'resource',
    'resourceMode',
  ] as const)(
    'rejects Graph refresh without stored %s instead of migrating legacy state',
    async (field) => {
      const { flowMetadata } = await initiate();
      const metadata = refreshMetadata(flowMetadata);
      delete metadata[field];
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token',
          metadata,
          {},
          GRAPH_CONFIG,
          ALLOWED_DOMAINS,
        ),
      ).rejects.toThrow();
      expect(tokenRequests).toHaveLength(0);
    },
  );

  it.each([
    {
      authorization_url: `${ENTRA_BASE.replace('11111111-2222-3333-4444-555555555555', 'common')}/authorize`,
      token_url: `${ENTRA_BASE.replace('11111111-2222-3333-4444-555555555555', 'common')}/token`,
    },
    { scope: 'User.Read offline_access' },
    { client_id: 'another-client' },
    { audience: 'https://graph.microsoft.com' },
    { resource_mode: undefined },
  ])('rejects refresh when the trusted Graph configuration changed: %j', async (changes) => {
    const { flowMetadata } = await initiate();
    await expect(
      MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token',
        refreshMetadata(flowMetadata),
        {},
        { ...GRAPH_CONFIG, ...changes },
        ALLOWED_DOMAINS,
      ),
    ).rejects.toThrow();
    expect(tokenRequests).toHaveLength(0);
  });

  it('rejects discovery of unrelated PRM in Graph mode', async () => {
    prmResource = 'https://attacker.example/mcp';
    await expect(initiate()).rejects.toThrow(/does not match server URL/);
    expect(tokenRequests).toHaveLength(0);
  });

  it('revalidates the bound PRM before exchanging a replayed Graph flow', async () => {
    const { flowMetadata } = await initiate();
    flowMetadata.resourceMetadata!.resource = 'https://attacker.example/mcp';
    await expect(exchange(flowMetadata)).rejects.toThrow(/does not match server URL/);
    expect(tokenRequests).toHaveLength(0);
  });

  it('rejects invalid stored PRM before a Graph refresh', async () => {
    const { flowMetadata } = await initiate();
    await expect(
      MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token',
        { ...refreshMetadata(flowMetadata), resource: 'https://attacker.example/mcp' },
        {},
        GRAPH_CONFIG,
        ALLOWED_DOMAINS,
      ),
    ).rejects.toThrow(/does not match server URL/);
    expect(tokenRequests).toHaveLength(0);
  });
});
