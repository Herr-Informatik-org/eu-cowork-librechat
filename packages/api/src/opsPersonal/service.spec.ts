import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Collection } from 'mongodb';
import type { Request } from 'express';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type {
  OpsPersonalGrant,
  OpsPersonalNative,
  OpsPersonalScope,
  OpsAuthorization,
} from './types';
import { OpsPersonalService, parseOpsAuthorization, requireOpsPersonalEnabled } from './service';
import { createMongoOpsPersonalStore } from './store';
import { createOpsPersonalRouter } from './router';
const OWNER = '507f1f77bcf86cd799439011';
const OPS = 'a8d2034d-75e6-48b3-9746-07474975e229';
const OTHER = 'a8d2034d-75e6-48b3-9746-07474975e228';
const SKILL = '507f1f77bcf86cd799439012';
const BASE: OpsPersonalScope[] = ['mail:compose', 'skills:use'];
let server: MongoMemoryServer;
let client: MongoClient;
let collection: Collection<OpsPersonalGrant>;
let service: OpsPersonalService;
let now: number;
let current: IUser | null;
let ids: string[];
let skillsAllowed: boolean;
let brainReads: number;
let version: string;
const env = {
  enabled: process.env.KISUNO_OPS_INTERNAL_ENABLED,
  tenant: process.env.KISUNO_OPS_TENANT_ID,
};
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  collection = client.db('synthetic_ops_personal').collection<OpsPersonalGrant>('grants');
});
afterAll(async () => {
  await client?.close();
  await server?.stop();
});
beforeEach(async () => {
  await collection.deleteMany({});
  now = Date.now();
  current = {
    id: OWNER,
    role: 'USER',
    email: 'synthetic@example.invalid',
    emailVerified: true,
    personalization: { memories: true },
  } as IUser;
  ids = [SKILL];
  skillsAllowed = true;
  brainReads = 0;
  version = '1';
  const native: OpsPersonalNative = {
    currentUser: async () => current,
    config: async () => ({}) as AppConfig,
    skillsAllowed: async () => skillsAllowed,
    brainAllowed: async (req) => req.user?.personalization?.memories !== false,
    skillIds: async () => ids,
    skill: async (id) => ({ id, name: 'mail-style', version, body: 'Use short paragraphs.' }),
    mailContext: async (req) => {
      expect(req.user?.id).toBe(OWNER);
      brainReads++;
      return { context: 'Synthetic mail preference.', status: 'available' };
    },
  };
  service = new OpsPersonalService(
    createMongoOpsPersonalStore(() => collection),
    native,
    () => now,
    () => undefined,
  );
  process.env.KISUNO_OPS_INTERNAL_ENABLED = 'true';
  process.env.KISUNO_OPS_TENANT_ID = 'cwv01';
});
afterEach(() => {
  if (env.enabled === undefined) delete process.env.KISUNO_OPS_INTERNAL_ENABLED;
  else process.env.KISUNO_OPS_INTERNAL_ENABLED = env.enabled;
  if (env.tenant === undefined) delete process.env.KISUNO_OPS_TENANT_ID;
  else process.env.KISUNO_OPS_TENANT_ID = env.tenant;
});
function authorization() {
  const verifier = randomBytes(32).toString('base64url');
  const input: OpsAuthorization = {
    response_type: 'code',
    client_id: 'ops',
    redirect_uri: 'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback',
    state: randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ops_user_id: OPS,
  };
  return { verifier, input };
}
async function grant(scopes = BASE) {
  const { verifier, input } = authorization();
  input.scope = scopes.join(' ');
  const redirect = await service.authorize(OWNER, input, scopes);
  const code = new URL(redirect.redirect_uri).searchParams.get('code')!;
  return {
    code,
    verifier,
    input,
    exchange: () => service.exchange(code, verifier, input.redirect_uri, OPS),
  };
}
const req = (access: string, ops = OPS): Request => {
  const value = Object.create(express.request) as Request;
  value.headers = { authorization: `Bearer ${access}`, 'x-ops-user-id': ops };
  return value;
};
const context = (access: string, options = {}) =>
  service.context(req(access), {
    input: 'Draft a synthetic reply.',
    skillIds: [],
    brain: false,
    ...options,
  });
const app = () => {
  const a = express();
  a.use(
    '/api/ops-personal',
    createOpsPersonalRouter(service, (r, _s, next) => {
      r.user = current!;
      next();
    }),
  );
  return a;
};

test('both internal CWV01 switches are mandatory', () => {
  expect(() => requireOpsPersonalEnabled({})).toThrow();
  expect(() =>
    requireOpsPersonalEnabled({
      KISUNO_OPS_INTERNAL_ENABLED: 'true',
      KISUNO_OPS_TENANT_ID: 'cwv02',
    }),
  ).toThrow();
  expect(() =>
    requireOpsPersonalEnabled({
      KISUNO_OPS_INTERNAL_ENABLED: 'true',
      KISUNO_OPS_TENANT_ID: 'cwv01',
    }),
  ).not.toThrow();
});
test('authorization enforces exact redirect, state, identity and S256', () => {
  const { input } = authorization();
  expect(parseOpsAuthorization(input)).toEqual(input);
  for (const delta of [
    { redirect_uri: 'https://ops.rzcloud.ch/' },
    { redirect_uri: 'https://ops.rzcloud.ch/evil' },
    { code_challenge_method: 'plain' },
    { state: 'short' },
    { ops_user_id: '../owner' },
  ])
    expect(() => parseOpsAuthorization({ ...input, ...delta } as OpsAuthorization)).toThrow();
});
test('real Mongo CAS permits only one concurrent code redemption', async () => {
  const g = await grant();
  const results = await Promise.allSettled([g.exchange(), g.exchange()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  await expect(g.exchange()).rejects.toMatchObject({ code: 'invalid_grant' });
});
test('invalid PKCE, OPS subject and redirect do not consume the code', async () => {
  const g = await grant();
  await expect(
    service.exchange(g.code, randomBytes(32).toString('base64url'), g.input.redirect_uri, OPS),
  ).rejects.toThrow();
  await expect(service.exchange(g.code, g.verifier, g.input.redirect_uri, OTHER)).rejects.toThrow();
  await expect(
    service.exchange(g.code, g.verifier, 'https://ops.rzcloud.ch/', OPS),
  ).rejects.toThrow();
  await expect(
    service.exchange(g.code, g.verifier, 'https://ops.rzcloud.ch/elsewhere', OPS),
  ).rejects.toThrow();
  expect((await g.exchange()).subject).toBe(OWNER);
});
test('code expires after five minutes', async () => {
  const g = await grant();
  now += 300000;
  await expect(g.exchange()).rejects.toThrow();
});
test('database retains hashes, never bearer secrets or mail content', async () => {
  const g = await grant();
  const t = await g.exchange();
  const stored = JSON.stringify(await collection.findOne({ _id: t.grant_id }));
  for (const value of [g.code, g.verifier, t.access_token, t.refresh_token])
    expect(stored).not.toContain(value);
  expect(t).toMatchObject({
    tenant_id: 'cwv01',
    subject: OWNER,
    ops_user_id: OPS,
    expires_in: 600,
  });
});
test('access is OPS-bound and does not accept refresh or code tokens', async () => {
  const g = await grant();
  const t = await g.exchange();
  await expect(service.access(t.access_token, OTHER)).rejects.toThrow();
  await expect(service.access(t.refresh_token, OPS)).rejects.toThrow();
  await expect(service.access(g.code, OPS)).rejects.toThrow();
});
test('access expiry and refresh replay invalidate the whole rotated family', async () => {
  const t = await (await grant()).exchange();
  now += 600000;
  await expect(context(t.access_token)).rejects.toThrow();
  const next = await service.refresh(t.refresh_token, OPS);
  await expect(context(next.access_token)).resolves.toMatchObject({ ownerId: OWNER });
  await expect(service.refresh(t.refresh_token, OPS)).rejects.toThrow();
  await expect(context(next.access_token)).rejects.toThrow();
  await expect(service.refresh(next.refresh_token, OPS)).rejects.toThrow();
});
test('refresh never extends the fixed consent lifetime', async () => {
  const t = await (await grant()).exchange();
  now += 30 * 86400000;
  await expect(service.refresh(t.refresh_token, OPS)).rejects.toThrow();
});
test('deleted, inactive or moved-tenant owner is rejected', async () => {
  const t = await (await grant()).exchange();
  const original = current;
  current = null;
  await expect(context(t.access_token)).rejects.toMatchObject({ code: 'inactive_user' });
  current = { ...original, tenantId: 'other-tenant' } as IUser;
  await expect(service.refresh(t.refresh_token, OPS)).rejects.toMatchObject({
    code: 'inactive_user',
  });
});
test('session revocation is restricted to the grant owner', async () => {
  const t = await (await grant()).exchange();
  await service.store.revoke(t.grant_id, new Date(now), 'foreign-owner');
  await expect(context(t.access_token)).resolves.toBeDefined();
  await service.store.revoke(t.grant_id, new Date(now), OWNER);
  await expect(context(t.access_token)).rejects.toThrow();
});
test('Brain and background require their independent scopes', async () => {
  const t = await (await grant()).exchange();
  await expect(context(t.access_token, { brain: true })).rejects.toMatchObject({
    code: 'insufficient_scope',
  });
  await expect(context(t.access_token, { background: true })).rejects.toMatchObject({
    code: 'insufficient_scope',
  });
  expect(brainReads).toBe(0);
});
test('consented background run only calls native owner-bound read helper', async () => {
  const t = await (await grant([...BASE, 'brain:read', 'mail:background'])).exchange();
  const result = await context(t.access_token, {
    brain: true,
    background: true,
    skillIds: [SKILL],
  });
  expect(result.sourcesUsed).toEqual({
    skills: [{ id: SKILL, name: 'mail-style', version: '1' }],
    brain: true,
  });
  expect(brainReads).toBe(1);
});
test('foreign and personally disabled Skills are denied', async () => {
  const t = await (await grant()).exchange();
  ids = [];
  await expect(context(t.access_token, { skillIds: [SKILL] })).rejects.toMatchObject({
    code: 'skill_forbidden',
  });
  ids = [SKILL];
  current!.skillStates = { [SKILL]: false };
  await expect(context(t.access_token, { skillIds: [SKILL] })).rejects.toMatchObject({
    code: 'skill_inactive',
  });
  expect((await service.skills(req(t.access_token))).skills).toEqual([]);
});
test('publication rechecks revocation, ACL, version, role and Brain optout', async () => {
  const t = await (await grant([...BASE, 'brain:read'])).exchange();
  const result = await context(t.access_token, { skillIds: [SKILL], brain: true });
  ids = [];
  await expect(result.assertActive()).rejects.toThrow();
  ids = [SKILL];
  version = '2';
  await expect(result.assertActive()).rejects.toThrow();
  version = '1';
  skillsAllowed = false;
  await expect(result.assertActive()).rejects.toThrow();
  skillsAllowed = true;
  current!.personalization = { memories: false };
  await expect(result.assertActive()).rejects.toThrow();
  current!.personalization = { memories: true };
  await service.revoke(t.refresh_token, OPS);
  await expect(result.assertActive()).rejects.toThrow();
});
test('bounded context rejects repeated Skill IDs and oversized mail', async () => {
  const t = await (await grant()).exchange();
  await expect(context(t.access_token, { skillIds: Array(9).fill(SKILL) })).rejects.toMatchObject({
    code: 'invalid_request',
  });
  await expect(context(t.access_token, { input: 'x'.repeat(40001) })).rejects.toMatchObject({
    code: 'invalid_request',
  });
});
test('public token endpoint rejects browsers and extra identity fields', async () => {
  const g = await grant();
  const body = {
    client_id: 'ops',
    grant_type: 'authorization_code',
    code: g.code,
    code_verifier: g.verifier,
    redirect_uri: g.input.redirect_uri,
    ops_user_id: OPS,
  };
  await request(app())
    .post('/api/ops-personal/token')
    .set('Origin', 'https://ops.rzcloud.ch')
    .send(body)
    .expect(403);
  await request(app())
    .post('/api/ops-personal/token')
    .send({ ...body, owner_id: OWNER })
    .expect(400);
  const result = await request(app()).post('/api/ops-personal/token').send(body).expect(200);
  expect(result.headers['cache-control']).toBe('no-store');
});
test('HTTP skill listing contains no raw context or Skill body', async () => {
  const t = await (await grant()).exchange();
  const result = await request(app())
    .get('/api/ops-personal/skills')
    .set('Authorization', `Bearer ${t.access_token}`)
    .set('X-OPS-User-ID', OPS)
    .expect(200);
  expect(result.body).toEqual({ skills: [{ id: SKILL, name: 'mail-style', version: '1' }] });
  await request(app()).post('/api/ops-personal/context').send({}).expect(404);
});
test('HTTP feature is absent outside CWV01', async () => {
  process.env.KISUNO_OPS_TENANT_ID = 'cwv02';
  const response = await request(app()).get('/api/ops-personal/skills').expect(404);
  expect(response.body.error).toBe('not_found');
});

test('session consent requires a bearer session and validates the logged-in owner', async () => {
  const { input } = authorization();
  await request(app())
    .post('/api/ops-personal/authorize')
    .send({ authorization: input, scopes: BASE })
    .expect(401);
  const result = await request(app())
    .post('/api/ops-personal/authorize')
    .set('Authorization', 'Bearer synthetic-session')
    .send({ authorization: input, scopes: BASE })
    .expect(200);
  const callback = new URL(result.body.redirect_uri);
  expect(callback.origin + callback.pathname).toBe(
    'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback',
  );
  expect(callback.searchParams.get('state')).toBe(input.state);
  expect(callback.searchParams.get('code')).toMatch(/^kopsc_/);
  expect(callback.searchParams.has('kisuno_code')).toBe(false);
  expect(
    await collection.countDocuments({ ownerId: OWNER, opsUserId: OPS, status: 'pending' }),
  ).toBe(1);
});
test('malformed and oversized JSON fail with bounded public errors', async () => {
  const malformed = await request(app())
    .post('/api/ops-personal/token')
    .set('Content-Type', 'application/json')
    .send('{bad')
    .expect(400);
  expect(malformed.body.error).toBe('invalid_request');
  const large = await request(app())
    .post('/api/ops-personal/token')
    .send({ private_mail: 'x'.repeat(17000) })
    .expect(413);
  expect(large.body.error).toBe('request_too_large');
  expect(JSON.stringify(large.body)).not.toContain('private_mail');
});
test('aborted context never starts a Skill or Brain read', async () => {
  const tokens = await (await grant([...BASE, 'brain:read'])).exchange();
  await expect(
    context(tokens.access_token, { brain: true, skillIds: [SKILL], signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(brainReads).toBe(0);
});

test('OAuth discovery is fixed and absent outside internal CWV01', async () => {
  const { createOpsPersonalDiscoveryRouter } = await import('./router');
  const discovery = express().use(
    '/.well-known/oauth-authorization-server',
    createOpsPersonalDiscoveryRouter(),
  );
  const result = await request(discovery)
    .get('/.well-known/oauth-authorization-server')
    .expect(200);
  expect(result.body).toMatchObject({
    issuer: 'https://cowork.herr-informatik.ch',
    token_endpoint: 'https://cowork.herr-informatik.ch/api/ops-personal/token',
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    ops_user_id_required: true,
  });
  expect(result.body.scopes_supported).toContain('skills:use');
  process.env.KISUNO_OPS_INTERNAL_ENABLED = 'false';
  await request(discovery).get('/.well-known/oauth-authorization-server').expect(404);
});
test('OAuth form exchange and connection verification bind issuer, owner and OPS subject', async () => {
  const g = await grant();
  const form = {
    client_id: 'ops',
    grant_type: 'authorization_code',
    code: g.code,
    code_verifier: g.verifier,
    redirect_uri: g.input.redirect_uri,
    ops_user_id: OPS,
  };
  const result = await request(app())
    .post('/api/ops-personal/token')
    .type('form')
    .send(form)
    .expect(200);
  const t = result.body;
  const info = await request(app())
    .get('/api/ops-personal/connection')
    .set('Authorization', `Bearer ${t.access_token}`)
    .set('X-OPS-User-ID', OPS)
    .expect(200);
  expect(info.body).toMatchObject({
    issuer: 'https://cowork.herr-informatik.ch',
    subject: OWNER,
    tenant_id: 'cwv01',
    ops_user_id: OPS,
    grant_id: t.grant_id,
    scope: 'mail:compose skills:use',
  });
  expect(info.body).not.toHaveProperty('email');
  await request(app())
    .get('/api/ops-personal/connection')
    .set('Authorization', `Bearer ${t.access_token}`)
    .set('X-OPS-User-ID', OTHER)
    .expect(401);
  const replay = await request(app())
    .post('/api/ops-personal/token')
    .type('form')
    .send(form)
    .expect(400);
  expect(replay.body.error).toBe('invalid_grant');
  await request(app())
    .post('/api/ops-personal/revoke')
    .type('form')
    .send({
      client_id: 'ops',
      token: t.refresh_token,
      token_type_hint: 'refresh_token',
      ops_user_id: OPS,
    })
    .expect(200);
  await request(app())
    .get('/api/ops-personal/connection')
    .set('Authorization', `Bearer ${t.access_token}`)
    .set('X-OPS-User-ID', OPS)
    .expect(401);
});
test('fixed browser origin and cross-site mutation protection are enforced', async () => {
  const { input } = authorization();
  const action = () =>
    request(app())
      .post('/api/ops-personal/authorize')
      .set('Authorization', 'Bearer synthetic-session');
  const body = { authorization: input, scopes: BASE };
  await action().set('Origin', 'https://evil.invalid').send(body).expect(403);
  await action().set('Sec-Fetch-Site', 'cross-site').send(body).expect(403);
  const response = await action()
    .set('Origin', 'https://cowork.herr-informatik.ch')
    .send(body)
    .expect(200);
  expect(response.body.redirect_uri).toMatch(/^https:\/\/ops\.rzcloud\.ch\//);
});
test('unverified email, foreign tenant and invalid expiry fail closed', async () => {
  const t = await (await grant()).exchange();
  const original = current!;
  current = { ...original, emailVerified: false } as IUser;
  await expect(context(t.access_token)).rejects.toMatchObject({ code: 'inactive_user' });
  current = { ...original, tenantId: 'other' } as IUser;
  await expect(context(t.access_token)).rejects.toMatchObject({ code: 'inactive_user' });
  current = { ...original, expiresAt: new Date('invalid') } as IUser;
  await expect(context(t.access_token)).rejects.toMatchObject({ code: 'inactive_user' });
});

test('OAuth scope request cannot be silently expanded by consent', async () => {
  const { input } = authorization();
  await expect(service.authorize(OWNER, input, [...BASE, 'brain:read'])).rejects.toMatchObject({
    code: 'invalid_scope',
  });
  const requested = { ...input, scope: 'mail:compose skills:use brain:read mail:background' };
  await expect(service.authorize(OWNER, requested, BASE)).resolves.toBeDefined();
  for (const scope of [
    'mail:compose skills:use tools:execute',
    'brain:read',
    'mail:compose skills:use skills:use',
  ])
    expect(() => parseOpsAuthorization({ ...input, scope })).toThrow();
  const info = await request(app())
    .get('/api/ops-personal/authorize')
    .query(input)
    .set('Authorization', 'Bearer synthetic-session')
    .expect(200);
  expect(info.body.optional_scopes).toEqual([]);
});

test('OAuth revocation of an unknown opaque token is idempotent', async () => {
  const result = await request(app())
    .post('/api/ops-personal/revoke')
    .type('form')
    .send({ client_id: 'ops', token: 'not-a-real-token', ops_user_id: OPS })
    .expect(200);
  expect(result.body).toEqual({ revoked: true });
});
