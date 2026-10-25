import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db } from 'mongodb';
import { createMailCodec } from './privateData';
import { createMailOAuth, readMailOAuthConfig, MAIL_ASSISTANT_SCOPES } from './oauth';
import type { MailCredential, MailOAuthState } from './oauth';

const owner = '64b123456789012345678901';
const config = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'fixture-only',
  callback: 'https://cowork.example/api/agents/office/mail-assistant/callback',
};
const codec = createMailCodec('ab'.repeat(32));
const existingGraphScopes = 'Mail.Read Calendars.Read Tasks.Read Files.Read.All Sites.Read.All';
describe('Personal mailbox OAuth ownership and lifecycle', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let mailboxEmail: string;
  let scopes: string;
  let calls: string[];
  let clock: number;
  let auditFailure: boolean;
  let accountAllowed: boolean;
  let beforeToken: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('mail_oauth_tests');
  }, 120000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await db.dropDatabase();
    mailboxEmail = 'person@example.com';
    scopes = MAIL_ASSISTANT_SCOPES;
    calls = [];
    clock = Date.now();
    auditFailure = false;
    accountAllowed = true;
    beforeToken = undefined;
  });
  const service = () =>
    createMailOAuth(config, {
      credentials: () => db.collection<MailCredential>('credentials'),
      states: () => db.collection<MailOAuthState>('states'),
      codec,
      now: () => clock,
      authorize: async (id) => {
        if (!accountAllowed) throw Error('disabled');
        return { id, email: 'person@example.com', emailVerified: true };
      },
      audit: async () => {
        if (auditFailure) throw Error('audit unavailable');
      },
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        expect(init?.redirect).toBe('error');
        if (url.includes('/token')) {
          expect(new URLSearchParams(String(init?.body)).get('scope')).toBe(MAIL_ASSISTANT_SCOPES);
          await beforeToken?.();
          return new Response(
            JSON.stringify({
              access_token: 'fixture-access',
              refresh_token: 'fixture-refresh',
              expires_in: 3600,
              scope: scopes,
            }),
            { status: 200 },
          );
        }
        expect(url).toBe('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName');
        return new Response(
          JSON.stringify({ id: 'mailbox-id', mail: mailboxEmail, userPrincipalName: mailboxEmail }),
          { status: 200 },
        );
      },
    });
  async function begin(instance = service()) {
    const url = new URL(await instance.start(owner));
    return { instance, state: url.searchParams.get('state')!, url };
  }
  it('requests only delegated own-mail draft permissions with PKCE and no forced consent', async () => {
    const { url } = await begin();
    expect(url.searchParams.get('scope')).toBe(MAIL_ASSISTANT_SCOPES);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(config.callback);
    const pending = await db.collection('states').findOne({ ownerId: owner });
    expect(JSON.stringify(pending)).not.toContain('verifier');
    expect(calls).toHaveLength(0);
  });
  it('stores encrypted owner-bound credentials and consumes state once', async () => {
    const { instance, state } = await begin();
    await instance.complete(state, 'fixture-code');
    expect(await instance.status(owner)).toEqual({
      connected: true,
      mailbox: 'person@example.com',
    });
    const stored = await db.collection<MailCredential>('credentials').findOne({ _id: owner });
    expect(stored!.ciphertext).not.toContain('fixture-access');
    expect(() => codec.open('another-user', 'oauth-token', stored!.ciphertext)).toThrow();
    expect(await instance.token(owner)).toBe('fixture-access');
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow();
  });
  it('rejects a different employee or administrator mailbox', async () => {
    const { instance, state } = await begin();
    mailboxEmail = 'admin@example.com';
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow('bestätigten Cowork');
    expect((await instance.status(owner)).connected).toBe(false);
  });
  it('accepts existing delegated Graph read permissions without requesting them at login or refresh', async () => {
    scopes = `${MAIL_ASSISTANT_SCOPES} ${existingGraphScopes} openid profile email`;
    const { instance, state, url } = await begin();
    expect(url.searchParams.get('scope')).toBe(MAIL_ASSISTANT_SCOPES);
    await instance.complete(state, 'fixture-code');
    expect((await instance.status(owner)).connected).toBe(true);
    clock += 3500000;
    calls.length = 0;
    expect(await instance.token(owner)).toBe('fixture-access');
    expect(calls.filter((url) => url.includes('/token'))).toHaveLength(1);
    expect((await instance.status(owner)).connected).toBe(true);
  });
  it('normalizes fully qualified Graph scopes at login and refresh', async () => {
    scopes = `User.Read Mail.ReadWrite ${existingGraphScopes}`
      .split(' ')
      .map((scope) => `https://graph.microsoft.com/${scope}`)
      .concat('offline_access', 'openid', 'profile', 'email')
      .join(' ');
    const { instance, state } = await begin();
    await instance.complete(state, 'fixture-code');
    clock += 3500000;
    expect(await instance.token(owner)).toBe('fixture-access');
    expect((await instance.status(owner)).connected).toBe(true);
  });
  it.each(['User.Read', 'Mail.ReadWrite'])(
    'still requires %s when existing read permissions are returned',
    async (missingScope) => {
      const { instance, state } = await begin();
      scopes = `${MAIL_ASSISTANT_SCOPES} ${existingGraphScopes}`
        .split(' ')
        .filter((scope) => scope !== missingScope)
        .join(' ');
      await expect(instance.complete(state, 'fixture-code')).rejects.toThrow('Postfachrechte');
      expect(calls).toHaveLength(1);
    },
  );
  const unsafeScopes = [
    'Mail.Send',
    'Mail.ReadWrite.Shared',
    'Mail.Read.Shared',
    'Calendars.ReadWrite',
    'Calendars.Read.Shared',
    'Tasks.ReadWrite',
    'Files.ReadWrite.All',
    'Sites.ReadWrite.All',
    'Directory.Read.All',
    'https://graph.microsoft.com/Mail.Send',
    'https://outlook.office.com/Mail.Read',
  ];
  it.each(unsafeScopes)('rejects extra granted scope %s at login', async (scope) => {
    const { instance, state } = await begin();
    scopes += ` ${scope}`;
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow('Postfachrechte');
    expect(calls).toHaveLength(1);
  });
  it.each(unsafeScopes)('rejects extra granted scope %s at refresh', async (scope) => {
    const { instance, state } = await begin();
    await instance.complete(state, 'fixture-code');
    clock += 3500000;
    calls.length = 0;
    scopes += ` ${scope}`;
    await expect(instance.token(owner)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect((await instance.status(owner)).connected).toBe(false);
  });
  it('refuses expired authorization state', async () => {
    const { instance, state } = await begin();
    clock += 11 * 60000;
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('does not resurrect a disconnected OAuth flow', async () => {
    const { instance, state } = await begin();
    beforeToken = () => instance.disconnect(owner);
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow();
    expect((await instance.status(owner)).connected).toBe(false);
  });
  it('never issues Graph calls merely to show local connection status', async () => {
    const { instance, state } = await begin();
    await instance.complete(state, 'fixture-code');
    calls.length = 0;
    await instance.status(owner);
    expect(calls).toHaveLength(0);
  });
  it('fails closed when the account is disabled or durable audit is unavailable', async () => {
    auditFailure = true;
    await expect(service().start(owner)).rejects.toThrow();
    expect(await db.collection('states').countDocuments()).toBe(0);
    auditFailure = false;
    const { instance, state } = await begin();
    accountAllowed = false;
    await expect(instance.complete(state, 'fixture-code')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('single-flights refresh and does not revive deleted tokens after a refresh', async () => {
    const { instance, state } = await begin();
    await instance.complete(state, 'fixture-code');
    clock += 3500000;
    calls.length = 0;
    await Promise.all([instance.token(owner), instance.token(owner)]);
    expect(calls.filter((url) => url.includes('/token'))).toHaveLength(1);
    clock += 3500000;
    beforeToken = () => instance.disconnect(owner);
    await expect(instance.token(owner)).rejects.toThrow();
    expect((await instance.status(owner)).connected).toBe(false);
  });
});

describe('Mailbox application configuration', () => {
  it.each([
    'http://cowork.example',
    'https://cowork.example/path',
    'https://name:password@cowork.example',
    'https://cowork.example?next=other',
  ])('rejects unsafe callback origin %s', (domain) => {
    expect(() =>
      readMailOAuthConfig({
        MAIL_ASSISTANT_TENANT_ID: config.tenantId,
        MAIL_ASSISTANT_CLIENT_ID: config.clientId,
        MAIL_ASSISTANT_CLIENT_SECRET: config.clientSecret,
        DOMAIN_SERVER: domain,
      }),
    ).toThrow();
  });
});
