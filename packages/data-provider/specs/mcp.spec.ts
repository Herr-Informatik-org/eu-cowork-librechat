import {
  MCPOptionsSchema,
  SSEOptionsSchema,
  StreamableHTTPOptionsSchema,
  MCPServerUserInputSchema,
  MCP_USER_INPUT_FIELDS,
  MicrosoftGraphOAuthOptionsSchema,
} from '../src/mcp';

describe('MCPOptionsSchema', () => {
  describe('OBO transport support', () => {
    it('should accept obo on SSE transport', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept obo on streamable-http transport', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject obo on WebSocket transport', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'websocket',
        url: 'wss://mcp-server.com/ws',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject obo on stdio transport', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('MCP schemas', () => {
  describe('env variable exfiltration prevention', () => {
    it('should confirm admin schema resolves env vars (attack vector baseline)', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const adminResult = SSEOptionsSchema.safeParse({
        type: 'sse',
        url: 'http://attacker.com/?secret=${FAKE_SECRET}',
      });
      expect(adminResult.success).toBe(true);
      if (adminResult.success) {
        expect(adminResult.data.url).toContain('leaked-secret-value');
      }
      delete process.env.FAKE_SECRET;
    });

    it('should reject the same URL through user input schema', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const userResult = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'http://attacker.com/?secret=${FAKE_SECRET}',
      });
      expect(userResult.success).toBe(false);
      delete process.env.FAKE_SECRET;
    });
  });

  describe('OAuth URL env variable resolution (admin schema)', () => {
    const OAUTH_AUTH_URL = 'https://auth.example.com/authorize';
    const OAUTH_TOKEN_URL = 'https://auth.example.com/token';
    const OAUTH_REDIRECT_URI = 'https://app.example.com/callback';
    const OAUTH_REVOCATION_URL = 'https://auth.example.com/revoke';

    beforeEach(() => {
      process.env.OAUTH_AUTH_URL = OAUTH_AUTH_URL;
      process.env.OAUTH_TOKEN_URL = OAUTH_TOKEN_URL;
      process.env.OAUTH_REDIRECT_URI = OAUTH_REDIRECT_URI;
      process.env.OAUTH_REVOCATION_URL = OAUTH_REVOCATION_URL;
    });

    afterEach(() => {
      delete process.env.OAUTH_AUTH_URL;
      delete process.env.OAUTH_TOKEN_URL;
      delete process.env.OAUTH_REDIRECT_URI;
      delete process.env.OAUTH_REVOCATION_URL;
    });

    it('should resolve env vars in authorization_url and token_url', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: '${OAUTH_AUTH_URL}',
          token_url: '${OAUTH_TOKEN_URL}',
          client_id: 'my-client',
        },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.authorization_url).toBe(OAUTH_AUTH_URL);
        expect(result.data.oauth.token_url).toBe(OAUTH_TOKEN_URL);
      }
    });

    it('should resolve env vars in redirect_uri', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        oauth: {
          redirect_uri: '${OAUTH_REDIRECT_URI}',
        },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.redirect_uri).toBe(OAUTH_REDIRECT_URI);
      }
    });

    it('should resolve env vars in revocation_endpoint', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          revocation_endpoint: '${OAUTH_REVOCATION_URL}',
        },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.revocation_endpoint).toBe(OAUTH_REVOCATION_URL);
      }
    });

    it('should accept plain OAuth URLs without env vars', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.direct.com/authorize',
          token_url: 'https://auth.direct.com/token',
          redirect_uri: 'https://app.direct.com/callback',
          revocation_endpoint: 'https://auth.direct.com/revoke',
          client_id: 'my-client',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid URLs after env var resolution', () => {
      process.env.OAUTH_BAD_URL = 'not-a-url';
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: '${OAUTH_BAD_URL}',
        },
      });
      expect(result.success).toBe(false);
      delete process.env.OAUTH_BAD_URL;
    });

    it('should pass through undefined when OAuth URL fields are omitted', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: { scope: 'openid' },
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.authorization_url).toBeUndefined();
        expect(result.data.oauth.token_url).toBeUndefined();
        expect(result.data.oauth.redirect_uri).toBeUndefined();
        expect(result.data.oauth.revocation_endpoint).toBeUndefined();
      }
    });
  });

  describe('env variable rejection', () => {
    it('should reject SSE URLs containing env variable patterns', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'http://attacker.com/?secret=${FAKE_SECRET}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject streamable-http URLs containing env variable patterns', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'http://attacker.com/?jwt=${JWT_SECRET}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject WebSocket URLs containing env variable patterns', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'websocket',
        url: 'ws://attacker.com/?secret=${FAKE_SECRET}',
      });
      expect(result.success).toBe(false);
    });

    it('should reject OAuth authorization_url containing env variable patterns', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://attacker.example/authorize?k=${FAKE_SECRET}',
        },
      });
      expect(result.success).toBe(false);
      delete process.env.FAKE_SECRET;
    });

    it('should reject OAuth token_url containing env variable patterns', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          token_url: 'https://attacker.example/token?k=${FAKE_SECRET}',
        },
      });
      expect(result.success).toBe(false);
      delete process.env.FAKE_SECRET;
    });

    it('should reject OAuth redirect_uri containing env variable patterns', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          redirect_uri: 'https://attacker.example/callback?k=${FAKE_SECRET}',
        },
      });
      expect(result.success).toBe(false);
      delete process.env.FAKE_SECRET;
    });

    it('should reject OAuth revocation_endpoint containing env variable patterns', () => {
      process.env.FAKE_SECRET = 'leaked-secret-value';
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          revocation_endpoint: 'https://attacker.example/revoke?k=${FAKE_SECRET}',
        },
      });
      expect(result.success).toBe(false);
      delete process.env.FAKE_SECRET;
    });
  });

  describe('proxy field restrictions', () => {
    it('should accept admin-configured proxies for SSE', () => {
      const result = SSEOptionsSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.proxy).toBe('http://proxy.example.com:8080');
      }
    });

    it('should accept admin-configured proxies for streamable-http', () => {
      const result = StreamableHTTPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.proxy).toBe('http://proxy.example.com:8080');
      }
    });

    it('should reject unsupported proxy protocols', () => {
      const result = StreamableHTTPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        proxy: 'ftp://proxy.example.com',
      });
      expect(result.success).toBe(false);
    });

    it('should reject SSE proxy configuration from user input', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(result.success).toBe(false);
    });

    it('should reject streamable-http proxy configuration from user input', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        proxy: 'http://proxy.example.com:8080',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('protocol allowlisting', () => {
    it('should reject file:// URLs for SSE', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'file:///etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('should reject ftp:// URLs for streamable-http', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'ftp://internal-server/data',
      });
      expect(result.success).toBe(false);
    });

    it('should reject http:// URLs for WebSocket', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'websocket',
        url: 'http://example.com/ws',
      });
      expect(result.success).toBe(false);
    });

    it('should reject ws:// URLs for SSE', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'ws://example.com/sse',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('valid URL acceptance', () => {
    it('should accept valid https:// SSE URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('https://mcp-server.com/sse');
      }
    });

    it('should accept valid http:// SSE URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'http://mcp-server.com/sse',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid wss:// WebSocket URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'websocket',
        url: 'wss://mcp-server.com/ws',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('wss://mcp-server.com/ws');
      }
    });

    it('should accept valid ws:// WebSocket URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'websocket',
        url: 'ws://mcp-server.com/ws',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid https:// streamable-http URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('https://mcp-server.com/http');
      }
    });

    it('should accept valid http:// streamable-http URLs with "http" alias', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'http',
        url: 'http://mcp-server.com/mcp',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('OBO configuration', () => {
    it('should accept obo field with valid scopes', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.obo).toEqual({
          scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite',
        });
      }
    });

    it('should accept obo on streamable-http transport', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        obo: { scopes: 'api://other-app/Custom.Scope' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject obo on WebSocket transport', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'websocket',
        url: 'wss://mcp-server.com/ws',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject obo with empty scopes', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        obo: { scopes: '' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject obo without scopes property', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
        obo: {},
      });
      expect(result.success).toBe(false);
    });

    it('should accept config without obo (optional)', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'sse',
        url: 'https://mcp-server.com/sse',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.obo).toBeUndefined();
      }
    });
  });

  describe('user-managed OAuth audience restrictions', () => {
    it('should reject audience from user-managed OAuth configuration', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          audience: 'https://api.example.com',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject refresh audience forwarding from user-managed OAuth configuration', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          forward_audience_on_refresh: false,
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject audience query parameters in user-managed OAuth authorization URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize?audience=https://api.example.com',
          token_url: 'https://auth.example.com/token',
          client_id: 'public-client-id',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject resource query parameters in user-managed OAuth token URLs', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token?resource=https://api.example.com',
          client_id: 'public-client-id',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should continue accepting non-audience OAuth fields from user-managed configuration', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'public-client-id',
          scope: 'read execute',
        },
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.authorization_url).toBe('https://auth.example.com/authorize');
        expect(result.data.oauth.token_url).toBe('https://auth.example.com/token');
        expect(result.data.oauth.client_id).toBe('public-client-id');
        expect(result.data.oauth.scope).toBe('read execute');
      }
    });
  });

  describe('OAuth confidential client endpoint pinning', () => {
    it('should reject client_secret without client_id', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
          client_secret: 'client-secret',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject client_secret with client_id when authorization_url is missing', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          token_url: 'https://auth.example.com/token',
          client_id: 'client-id',
          client_secret: 'client-secret',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject client_secret with client_id when token_url is missing', () => {
      const result = MCPServerUserInputSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          client_id: 'client-id',
          client_secret: 'client-secret',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should accept client_id without client_secret for auto-discovery', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          client_id: 'public-client-id',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should accept client_secret when both OAuth endpoints are pinned', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'client-id',
          client_secret: 'client-secret',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should accept audience parameter (Auth0/Cognito-style)', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          audience: 'https://api.example.com',
        },
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.audience).toBe('https://api.example.com');
      }
    });

    it('should accept audience alongside scope and other OAuth fields', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
          scope: 'read execute',
          audience: 'https://api.example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should treat audience as optional (omitting it is fine)', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          scope: 'read',
        },
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.audience).toBeUndefined();
      }
    });

    it('should reject empty-string audience', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          audience: '',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should accept forward_audience_on_refresh = false (Cognito opt-out)', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          audience: 'https://api.example.com',
          forward_audience_on_refresh: false,
        },
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.forward_audience_on_refresh).toBe(false);
      }
    });

    it('should treat forward_audience_on_refresh as optional', () => {
      const result = MCPOptionsSchema.safeParse({
        type: 'streamable-http',
        url: 'https://mcp-server.com/http',
        oauth: {
          audience: 'https://api.example.com',
        },
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.oauth) {
        expect(result.data.oauth.forward_audience_on_refresh).toBeUndefined();
      }
    });
  });
});

describe('administrator-configured Microsoft Graph OAuth', () => {
  const server = { type: 'streamable-http', url: 'https://office.example/mcp' };
  const graphOAuth = {
    resource_mode: 'microsoft_graph' as const,
    client_id: 'graph-client-id',
    authorization_url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    scope: 'openid profile email offline_access User.Read Sites.Read.All',
  };

  it.each(['common', 'organizations', '11111111-2222-3333-4444-aaaaaaaaaaaa'])(
    'accepts the Graph resource mode for tenant %s in administrator config and runtime validation',
    (tenant) => {
      const oauth = {
        ...graphOAuth,
        authorization_url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token_url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      };
      expect(MCPOptionsSchema.parse({ ...server, oauth }).oauth).toEqual(oauth);
      expect(MicrosoftGraphOAuthOptionsSchema.parse(oauth)).toEqual(oauth);
    },
  );

  it.each([
    'User.Read',
    'Sites.Read.All offline_access',
    '.default',
    'https://graph.microsoft.com/.default offline_access',
    'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Sites.Read.All openid',
  ])('accepts Graph scope %s', (scope) => {
    const oauth = { ...graphOAuth, scope };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(true);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(true);
  });

  describe('administrator scope environment references', () => {
    let originalScope: string | undefined;
    let originalUserScope: string | undefined;

    beforeEach(() => {
      originalScope = process.env.MS365_OFFICE_OAUTH_SCOPE;
      originalUserScope = process.env.userVar;
      delete process.env.MS365_OFFICE_OAUTH_SCOPE;
      delete process.env.userVar;
    });

    afterEach(() => {
      if (originalScope === undefined) {
        delete process.env.MS365_OFFICE_OAUTH_SCOPE;
      } else {
        process.env.MS365_OFFICE_OAUTH_SCOPE = originalScope;
      }
      if (originalUserScope === undefined) {
        delete process.env.userVar;
      } else {
        process.env.userVar = originalUserScope;
      }
    });

    it('validates resolved administrator scopes while preserving the configured reference', () => {
      process.env.MS365_OFFICE_OAUTH_SCOPE = graphOAuth.scope;
      const oauth = { ...graphOAuth, scope: '${MS365_OFFICE_OAUTH_SCOPE}' };

      expect(MCPOptionsSchema.parse({ ...server, oauth }).oauth).toEqual(oauth);
      expect(MicrosoftGraphOAuthOptionsSchema.parse(oauth)).toEqual(oauth);
      expect(MCPServerUserInputSchema.safeParse({ ...server, oauth }).success).toBe(false);
    });

    it('rejects a reference whose administrator environment variable is unset', () => {
      const oauth = { ...graphOAuth, scope: '${MS365_OFFICE_OAUTH_SCOPE}' };

      expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    });

    it.each(['', ' ', 'openid offline_access', 'api://custom-resource/access_as_user'])(
      'rejects invalid resolved administrator scope %p',
      (scope) => {
        process.env.MS365_OFFICE_OAUTH_SCOPE = scope;
        const oauth = { ...graphOAuth, scope: '${MS365_OFFICE_OAUTH_SCOPE}' };

        expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
        expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
      },
    );

    it('rejects unresolved custom user variables even when another Graph scope is present', () => {
      const oauth = { ...graphOAuth, scope: 'User.Read ${userVar}' };
      const customUserVars = { userVar: { title: 'Scope', description: 'Benutzereingabe' } };

      expect(MCPOptionsSchema.safeParse({ ...server, oauth, customUserVars }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    });
  });

  it.each([undefined, '', ' ', '\t\n'])(
    'rejects a missing or blank client_id (%p)',
    (client_id) => {
      const oauth = { ...graphOAuth, client_id };
      expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    },
  );

  describe.each([
    ['authorization_url', 'authorize'],
    ['token_url', 'token'],
  ] as const)('%s validation', (field, action) => {
    it.each([
      undefined,
      '',
      'http://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com.evil.example/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com@evil.example/organizations/oauth2/v2.0/ACTION',
      'https://user:password@login.microsoftonline.com/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com:443/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com:8443/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/tenant.example.com/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/organizations/oauth2/ACTION',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION/',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION?prompt=consent',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION?',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION#fragment',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/ACTION#',
      'https://login.microsoftonline.com/%6frganizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/organizations%2f/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/%61CTION',
      'https://login.microsoftonline.com/organizations/../organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com/organizations/%2e%2e/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com\\organizations\\oauth2\\v2.0\\ACTION',
      'https://login.micro\nsoftonline.com/organizations/oauth2/v2.0/ACTION',
      'https://login%2emicrosoftonline.com/organizations/oauth2/v2.0/ACTION',
      'https://login.microsoftonline.com./organizations/oauth2/v2.0/ACTION',
    ])('rejects unsafe or missing endpoint %p', (endpoint) => {
      const oauth = { ...graphOAuth, [field]: endpoint?.replace('ACTION', action) };
      expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    });

    it('requires the endpoint for its intended action', () => {
      const oauth = {
        ...graphOAuth,
        [field]: `https://login.microsoftonline.com/organizations/oauth2/v2.0/${action === 'authorize' ? 'token' : 'authorize'}`,
      };
      expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    });
  });

  it('requires both endpoints to use the same tenant', () => {
    const oauth = {
      ...graphOAuth,
      token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
  });

  it('compares tenant GUIDs without regard to letter case', () => {
    const oauth = {
      ...graphOAuth,
      authorization_url:
        'https://login.microsoftonline.com/11111111-2222-3333-4444-AAAAAAAAAAAA/oauth2/v2.0/authorize',
      token_url:
        'https://login.microsoftonline.com/11111111-2222-3333-4444-aaaaaaaaaaaa/oauth2/v2.0/token',
    };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(true);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(true);
  });

  it('rejects tenant line breaks even when both endpoints share them', () => {
    const oauth = {
      ...graphOAuth,
      authorization_url: 'https://login.microsoftonline.com/organizations\n/oauth2/v2.0/authorize',
      token_url: 'https://login.microsoftonline.com/organizations\n/oauth2/v2.0/token',
    };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
  });

  it.each([
    undefined,
    '',
    ' ',
    'openid profile email offline_access',
    'read',
    'User.Read api://custom-resource/access_as_user',
    'https://tenant.sharepoint.com/Sites.Read.All',
    'https://graph.microsoft.com.evil.example/User.Read',
    'https://graph.microsoft.com@evil.example/User.Read',
    'https://graph.microsoft.com:443/User.Read',
    'http://graph.microsoft.com/User.Read',
    'https://graph.microsoft.com/',
    'https://graph.microsoft.com/openid',
    'https://graph.microsoft.com/User.Read?resource=other',
    'https://graph.microsoft.com/User.Read#fragment',
    'https://graph.microsoft.com/../User.Read',
    'https://graph.microsoft.com/%55ser.Read',
    'https://graph%2emicrosoft.com/User.Read',
    'User..Read',
    'User.Read/',
    'User.Read custom_scope',
  ])('rejects scopes outside Graph and OIDC or without a Graph permission (%p)', (scope) => {
    const oauth = { ...graphOAuth, scope };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
  });

  it.each(['https://graph.microsoft.com', '', undefined])(
    'rejects an explicit audience even when empty or undefined (%p)',
    (audience) => {
      const oauth = { ...graphOAuth, audience };
      expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
      expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
    },
  );

  it.each(['mcp', 'microsoft_graph', 'other', null])(
    'rejects resource_mode %p in user-managed configuration',
    (resource_mode) => {
      expect(
        MCPServerUserInputSchema.safeParse({
          ...server,
          oauth: { ...graphOAuth, resource_mode },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects unknown resource modes in administrator and runtime schemas', () => {
    const oauth = { ...graphOAuth, resource_mode: 'custom' };
    expect(MCPOptionsSchema.safeParse({ ...server, oauth }).success).toBe(false);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
  });

  it.each([undefined, 'mcp'])('preserves standard OAuth with resource_mode %p', (resource_mode) => {
    const oauth = { client_id: 'public-client', scope: 'read', resource_mode };
    expect(MCPOptionsSchema.parse({ ...server, oauth }).oauth).toEqual(oauth);
    expect(MicrosoftGraphOAuthOptionsSchema.safeParse(oauth).success).toBe(false);
  });
});

describe('MCP_USER_INPUT_FIELDS', () => {
  it('includes the expected user-input fields and excludes server-managed ones', () => {
    // Sanity check on the schema-derived field set. This is the comparison
    // surface for the OBO lockdown check in updateMCPServerController; if it
    // drifts unexpectedly, the lockdown could miss a new field. Add new
    // entries here when you add new user-input fields to the schema.
    expect(MCP_USER_INPUT_FIELDS.has('type')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('url')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('title')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('description')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('iconPath')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('oauth')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('apiKey')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('obo')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('proxy')).toBe(true);
    expect(MCP_USER_INPUT_FIELDS.has('headers')).toBe(true);

    // Server-managed fields should NOT be in this set — they're stripped by
    // omitServerManagedFields() before MCPServerUserInputSchema is built.
    expect(MCP_USER_INPUT_FIELDS.has('startup')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('timeout')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('chatMenu')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('requiresOAuth')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('customUserVars')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('oauth_headers')).toBe(false);

    // Stdio is intentionally excluded from MCPServerUserInputSchema (security
    // posture), so its transport-only fields should not be in the set either.
    expect(MCP_USER_INPUT_FIELDS.has('command')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('args')).toBe(false);
    expect(MCP_USER_INPUT_FIELDS.has('env')).toBe(false);
  });
});

describe('administrator-required MCP approval', () => {
  const server = { type: 'streamable-http', url: 'https://office.example/mcp' };
  test('accepts bounded tool globs in administrator config', () => {
    expect(
      MCPOptionsSchema.parse({ ...server, requireToolApproval: ['create-*'] }).requireToolApproval,
    ).toEqual(['create-*']);
  });
  test('rejects invalid or oversized policies', () => {
    for (const policy of ['', [null], [' '], ['x'.repeat(257)], Array(101).fill('*')]) {
      expect(MCPOptionsSchema.safeParse({ ...server, requireToolApproval: policy }).success).toBe(
        false,
      );
    }
  });
  test('user-managed MCP input cannot provide an approval policy', () => {
    const parsed = MCPServerUserInputSchema.parse({ ...server, requireToolApproval: [] });
    expect(parsed).not.toHaveProperty('requireToolApproval');
    expect(MCP_USER_INPUT_FIELDS.has('requireToolApproval')).toBe(false);
  });
});
