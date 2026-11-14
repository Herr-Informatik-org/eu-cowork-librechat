import express from 'express';
import request from 'supertest';
import { publicEncrypt, constants } from 'node:crypto';
import { createOutlookAdminRouter } from './admin';
const mockRows = new Map<string, any>();
const mockAudit = jest.fn().mockResolvedValue({ id: 'audit' });
const match = (row: any, query: any) =>
  row &&
  Object.entries(query).every(([key, value]: any) =>
    typeof value === 'object' && value?.$gt ? row[key] > value.$gt : row[key] === value,
  );
const mockCollection = {
  findOne: async (q: any) => [...mockRows.values()].find((row) => match(row, q)) ?? null,
  insertOne: async (row: any) => {
    mockRows.set(row._id, row);
    return { acknowledged: true };
  },
  deleteMany: async () => ({ deletedCount: 0 }),
  deleteOne: async (q: any) => {
    const row = [...mockRows.values()].find((row) => match(row, q));
    return { deletedCount: row && mockRows.delete(row._id) ? 1 : 0 };
  },
  updateOne: async (q: any, update: any) => {
    const row = mockRows.get(q._id) || { _id: q._id };
    mockRows.set(q._id, { ...row, ...update.$set });
    return { modifiedCount: 1 };
  },
};
jest.mock('mongoose', () => ({
  __esModule: true,
  default: { connection: { collection: () => mockCollection } },
}));
jest.mock('@librechat/data-schemas', () => ({
  encryptV2: async (v: string) => v,
  decryptV2: async (v: string) => v,
  getTenantId: () => 'tenant-a',
  createMethods: () => ({ recordAuditEntry: (...args: any[]) => mockAudit(...args) }),
}));
let admin = 'operator-a';
const app = express();
app.use((req: any, _res, next) => {
  req.user = { id: admin };
  next();
});
app.use(createOutlookAdminRouter());
beforeEach(() => {
  mockRows.clear();
  mockAudit.mockResolvedValue({ id: 'audit' });
  admin = 'operator-a';
  process.env.KISUNO_OUTLOOK_ENABLED = 'true';
  process.env.ALLOW_SHARED_LINKS = 'false';
  process.env.DOMAIN_SERVER = 'https://chat.example.test';
});
async function registration() {
  const response = await request(app).post('/registration').send({});
  expect(response.status).toBe(200);
  const encoded = response.body.script.match(/FromBase64String\('([^']+)'\)/)[1];
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
  const body = {
    registrationId: payload.id,
    tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
    ciphertext: publicEncrypt(
      { key: payload.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from('fixture-only-password'),
    ).toString('base64'),
  };
  return { response, payload, body };
}
it('disables all administration on other tenants and when public sharing is still enabled', async () => {
  delete process.env.KISUNO_OUTLOOK_ENABLED;
  expect((await request(app).post('/registration').send({})).status).toBe(404);
  expect(mockRows.size).toBe(0);
  process.env.KISUNO_OUTLOOK_ENABLED = 'true';
  delete process.env.ALLOW_SHARED_LINKS;
  expect((await request(app).get('/')).status).toBe(404);
});
it('downloads only a public-key script and imports exactly once without revealing credentials', async () => {
  const { response, payload, body } = await registration();
  expect(response.body.script).not.toContain('PRIVATE KEY');
  expect(payload.redirectUri).toBe(
    'https://chat.example.test/api/mcp/kisuno-outlook/oauth/callback',
  );
  const imported = await request(app).post('/registration/import').send(body);
  expect(imported.status).toBe(200);
  expect(imported.body.configured).toBe(true);
  expect(imported.body.enabled).toBe(false);
  expect(imported.body.consentVerified).toBe(false);
  expect(JSON.stringify(imported.body)).not.toContain('fixture-only-password');
  expect((await request(app).post('/registration/import').send(body)).status).toBe(400);
  const status = await request(app).get('/');
  expect(JSON.stringify(status.body)).not.toMatch(/privateKey|ciphertext|clientSecret|encrypted/);
  const generation = status.body.generation;
  expect((await request(app).put('/').send({ generation, enabled: true })).body.enabled).toBe(true);
  expect((await request(app).put('/').send({ generation, enabled: false })).body.enabled).toBe(
    false,
  );
});
it('rejects registration use by another administrator', async () => {
  const { body } = await registration();
  admin = 'operator-b';
  expect((await request(app).post('/registration/import').send(body)).status).toBe(400);
  expect(mockRows.has('settings:tenant-a')).toBe(false);
});
it('rejects expired and corrupted handoffs and arbitrary extra configuration', async () => {
  const { body } = await registration();
  for (const change of [
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { ciphertext: Buffer.alloc(384).toString('base64') },
    { url: 'https://evil.test' },
    { tenantId: 'organizations' },
  ])
    expect(
      (
        await request(app)
          .post('/registration/import')
          .send({ ...body, ...change })
      ).status,
    ).toBe(400);
  expect(mockRows.has('settings:tenant-a')).toBe(false);
});
it('refuses stale enablement and fails closed before registration when audit fails', async () => {
  expect(
    (
      await request(app)
        .put('/')
        .send({ generation: '11111111-1111-4111-8111-111111111111', enabled: true })
    ).status,
  ).toBe(409);
  mockAudit.mockResolvedValue(null);
  expect((await request(app).post('/registration').send({})).status).toBe(400);
  expect(mockRows.size).toBe(0);
});
