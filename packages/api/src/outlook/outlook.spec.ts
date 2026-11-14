import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isAddressAllowed } from '~/auth/domain';
import {
  assertOutlookArguments,
  assertOutlookScopes,
  assertOutlookTool,
  OUTLOOK_SCOPES,
  OUTLOOK_TOOLS,
} from './policy';
import {
  verifyOutlookIdentity,
  managedOutlookConfig,
  beforeOutlookRead,
  bindOutlookLogin,
} from './runtime';
import { outlookRegistrationScript } from './registration';
const mockUser = { id: 'local-owner', email: 'fabian@example.test', emailVerified: true };
const mockSettings = {
  enabled: true,
  generation: 'generation-a',
  clientId: '22222222-2222-4222-8222-222222222222',
  expiresAt: new Date(Date.now() + 86400000),
  encrypted: '',
};
let mockIdentity: any = null;
let mockUseAllowed = true;
let mockBan: any = null;
let mockTokens = true;
const mockAudit = jest.fn().mockResolvedValue({ id: 'mockAudit' });
const mockInsertOne = jest.fn(async (value) => {
  mockIdentity = value;
  return { acknowledged: true };
});
const mockUpdateOne = jest.fn(async (..._args: any[]) => ({ modifiedCount: 1 }));
const mockFindOne = jest.fn(async (query: any) =>
  query._id.startsWith('settings:') ? mockSettings : mockIdentity,
);
jest.mock('mongoose', () => ({
  __esModule: true,
  default: {
    connection: {
      collection: (name: string) =>
        name === 'logs'
          ? { findOne: async () => mockBan }
          : {
              findOne: (query: any) => mockFindOne(query),
              insertOne: (value: any) => mockInsertOne(value),
              updateOne: (...args: any[]) => mockUpdateOne(...args),
            },
    },
  },
}));
jest.mock('@librechat/data-schemas', () => ({
  encryptV2: async (v: string) => v,
  decryptV2: async (v: string) => v,
  getTenantId: () => 'customer-a',
  createMethods: () => ({
    getUserById: async () => mockUser,
    getRoleByName: async () => ({ permissions: { MCP_SERVERS: { USE: mockUseAllowed } } }),
    recordAuditEntry: (...args: any[]) => mockAudit(...args),
    findToken: async () =>
      mockTokens ? { token: JSON.stringify({ client_id: mockSettings.clientId }) } : null,
  }),
}));
const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = mockSettings.clientId;
const oid = '33333333-3333-4333-8333-333333333333';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
const makeToken = (changes = {}, options = {}) =>
  jwt.sign({ tid: tenantId, oid, nonce: 'attempt-a', ...changes }, privateKey, {
    algorithm: 'RS256',
    keyid: 'test-key',
    audience: clientId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    expiresIn: '5m',
    ...options,
  });
const fetcher = jest.fn(
  async (url: any) =>
    new Response(
      JSON.stringify(
        String(url).includes('/keys')
          ? { keys: [jwk] }
          : { id: oid, mail: mockUser.email, userPrincipalName: mockUser.email },
      ),
      { status: 200 },
    ),
);
const verify = (idToken = makeToken()) =>
  verifyOutlookIdentity(
    { idToken, accessToken: 'delegated-test', nonce: 'attempt-a', tenantId, clientId },
    fetcher as any,
  );
beforeEach(() => {
  process.env.KISUNO_OUTLOOK_ENABLED = 'true';
  process.env.ALLOW_SHARED_LINKS = 'false';
  mockSettings.enabled = true;
  mockSettings.encrypted = JSON.stringify({
    scope: 'customer-a',
    generation: mockSettings.generation,
    tenantId,
    clientId,
    clientSecret: 'fixture-only',
  });
  mockIdentity = null;
  mockTokens = true;
  mockUser.emailVerified = true;
  mockUseAllowed = true;
  mockBan = null;
  mockAudit.mockResolvedValue({ id: 'mockAudit' });
  jest.clearAllMocks();
});
it('allows the exact delegated read scopes and refuses writes or missing shared rights', () => {
  expect(() => assertOutlookScopes(OUTLOOK_SCOPES)).not.toThrow();
  for (const scope of [
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.ReadWrite.Shared',
    'Tasks.Read',
    'Sites.Read.All',
    'Directory.Read.All',
  ])
    expect(() => assertOutlookScopes(`${OUTLOOK_SCOPES} ${scope}`)).toThrow();
  expect(() => assertOutlookScopes('User.Read Mail.Read Calendars.Read')).toThrow();
});
it('permits shared reads but no writes, arbitrary Graph or directory enumeration', () => {
  for (const name of OUTLOOK_TOOLS) expect(() => assertOutlookTool(name)).not.toThrow();
  for (const name of [
    'send-mail',
    'create-calendar-event',
    'graph-batch',
    'list-users',
    'get-mail-message-extra',
    'login',
  ])
    expect(() => assertOutlookTool(name)).toThrow();
});
it('defaults off and never offers an app-shared connection', async () => {
  delete process.env.KISUNO_OUTLOOK_ENABLED;
  expect(await managedOutlookConfig(mockUser.id)).toBeUndefined();
  process.env.KISUNO_OUTLOOK_ENABLED = 'true';
  expect(await managedOutlookConfig()).toBeUndefined();
  mockSettings.enabled = false;
  expect(await managedOutlookConfig(mockUser.id)).toBeUndefined();
});
it('uses personal OAuth at fixed tenant-bound Microsoft endpoints', async () => {
  const config = await managedOutlookConfig(mockUser.id);
  expect(config?.startup).toBe(false);
  expect(config?.oauth?.resource_mode).toBe('microsoft_graph');
  expect(config?.oauth?.authorization_url).toContain(tenantId);
  expect(config?.oauth?.scope).toBe(OUTLOOK_SCOPES);
  expect(config?.url).toBe('http://ms365-office-mcp:3000/mcp');
});
it('refuses unverified local identities', async () => {
  mockUser.emailVerified = false;
  await expect(managedOutlookConfig(mockUser.id)).rejects.toThrow();
});
it('verifies signed organisation, application, nonce and matching Graph account', async () => {
  await expect(verify()).resolves.toMatchObject({ oid, tenantId, email: mockUser.email });
  expect(fetcher.mock.calls[0][0]).toBe(
    `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
  );
});
it.each([
  { nonce: 'other-attempt' },
  { tid: '44444444-4444-4444-8444-444444444444' },
  { oid: '44444444-4444-4444-8444-444444444444' },
])('rejects mockIdentity/flow mismatch %j', async (changes) => {
  await expect(verify(makeToken(changes))).rejects.toThrow();
});
it.each([{ issuer: 'https://evil.test' }, { audience: 'different-client' }, { expiresIn: '-1m' }])(
  'rejects wrong issuer, audience or expiry %j',
  async (options) => {
    await expect(verify(makeToken({}, options))).rejects.toThrow();
  },
);
it('rejects missing, opaque and HMAC-substituted evidence', async () => {
  for (const token of [
    '',
    'opaque',
    jwt.sign({ tid: tenantId, oid, nonce: 'attempt-a' }, 'fixture-only'),
  ])
    await expect(verify(token)).rejects.toThrow();
});
it('rejects blocked and oversized Microsoft responses', async () => {
  for (const fetcher of [
    async () => new Response('blocked', { status: 403 }),
    async () => new Response(' '.repeat(262145)),
  ])
    await expect(
      verifyOutlookIdentity(
        { idToken: makeToken(), accessToken: 'delegated', nonce: 'attempt-a', tenantId, clientId },
        fetcher as any,
      ),
    ).rejects.toThrow();
});
it('blocks reading without a verified owner', async () => {
  await expect(beforeOutlookRead(mockUser.id, 'get-shared-calendar-view')).rejects.toThrow();
});
it('rechecks revocation, administrator enablement and mandatory mockAudit for each read', async () => {
  mockIdentity = {
    encrypted: JSON.stringify({
      ownerId: mockUser.id,
      scope: 'customer-a',
      generation: mockSettings.generation,
    }),
  };
  await beforeOutlookRead(mockUser.id, 'get-shared-calendar-view');
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending' }), {
    failClosed: true,
  });
  mockTokens = false;
  await expect(beforeOutlookRead(mockUser.id, 'get-shared-calendar-view')).rejects.toThrow();
  mockTokens = true;
  mockSettings.enabled = false;
  await expect(beforeOutlookRead(mockUser.id, 'get-shared-calendar-view')).rejects.toThrow();
  mockSettings.enabled = true;
  mockAudit.mockResolvedValue(null);
  await expect(beforeOutlookRead(mockUser.id, 'get-shared-calendar-view')).rejects.toThrow();
});
it('rejects substituted customer, owner and obsolete generation records', async () => {
  for (const change of [{ ownerId: 'other' }, { scope: 'customer-b' }, { generation: 'old' }]) {
    mockIdentity = {
      encrypted: JSON.stringify({
        ownerId: mockUser.id,
        scope: 'customer-a',
        generation: mockSettings.generation,
        ...change,
      }),
    };
    await expect(beforeOutlookRead(mockUser.id, 'get-mail-message')).rejects.toThrow();
  }
});
it('generates only delegated consent with an encrypted credential handoff', () => {
  const script = outlookRegistrationScript({
    id: 'fixture-id',
    publicKey: 'public-only',
    redirectUri: 'https://example.test/callback',
  });
  for (const text of [
    "signInAudience='AzureADMyOrg'",
    "type='Scope'",
    'OaepSHA256',
    '/oauth2PermissionGrants',
  ])
    expect(script).toContain(text);
  for (const text of ["type='Role'", 'Mail.ReadWrite', 'Mail.Send', 'Write-Host $credential'])
    expect(script).not.toContain(text);
});

it('binds only the confirmed personal email and refuses switching an existing identity', async () => {
  const previousFetch = global.fetch;
  global.fetch = fetcher as any;
  try {
    await bindOutlookLogin(
      mockUser.id,
      { access_token: 'delegated', id_token: makeToken(), scope: OUTLOOK_SCOPES },
      'attempt-a',
      clientId,
    );
    expect(mockInsertOne).toHaveBeenCalled();
    mockIdentity.encrypted = JSON.stringify({
      ownerId: mockUser.id,
      scope: 'customer-a',
      tenantId,
      oid: '44444444-4444-4444-8444-444444444444',
    });
    await expect(
      bindOutlookLogin(
        mockUser.id,
        { access_token: 'delegated', id_token: makeToken(), scope: OUTLOOK_SCOPES },
        'attempt-a',
        clientId,
      ),
    ).rejects.toThrow();
    mockIdentity = null;
    const email = mockUser.email;
    mockUser.email = 'another@example.test';
    fetcher
      .mockImplementationOnce(async () => Response.json({ keys: [jwk] }))
      .mockImplementationOnce(async () =>
        Response.json({
          id: oid,
          mail: 'fabian@example.test',
          userPrincipalName: 'fabian@example.test',
        }),
      );
    await expect(
      bindOutlookLogin(
        mockUser.id,
        { access_token: 'delegated', id_token: makeToken(), scope: OUTLOOK_SCOPES },
        'attempt-a',
        clientId,
      ),
    ).rejects.toThrow();
    mockUser.email = email;
  } finally {
    global.fetch = previousFetch;
  }
});

it('refuses attachment expansion and in-band account switching', () => {
  for (const key of ['expand', '$expand', 'expandExtendedProperties', 'account'])
    expect(() => assertOutlookArguments({ [key]: 'fixture' })).toThrow();
  expect(() => assertOutlookArguments({ select: 'subject,body', top: 20 })).not.toThrow();
});

it('limits the private network exception to the exact connector host and port', () => {
  const allowed = ['ms365-office-mcp:3000'];
  expect(isAddressAllowed('ms365-office-mcp', allowed, 3000)).toBe(true);
  expect(isAddressAllowed('ms365-office-mcp', allowed, 80)).toBe(false);
  expect(isAddressAllowed('127.0.0.1', allowed, 3000)).toBe(false);
  expect(isAddressAllowed('another-tenant', allowed, 3000)).toBe(false);
});

it('rechecks revoked role rights and active account bans before exposing the connector', async () => {
  mockUseAllowed = false;
  await expect(managedOutlookConfig(mockUser.id)).rejects.toThrow();
  mockUseAllowed = true;
  mockBan = { expiresAt: new Date(Date.now() + 10000) };
  await expect(managedOutlookConfig(mockUser.id)).rejects.toThrow();
});
