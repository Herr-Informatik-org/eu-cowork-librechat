import express from 'express';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Collection } from 'mongodb';
import { createMailSecurityAdminRouter, createMailSecurityPolicy } from './policy';
import type { MailSecurityPolicy } from './policy';

describe('instance mail link security policy', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let collection: Collection<MailSecurityPolicy>;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    collection = client.db('mail_security_test').collection('policy');
  }, 120000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await collection.deleteMany({});
  });
  const env = { MAIL_ASSISTANT_INSTANCE: 'cw01', MAIL_ASSISTANT_ERP_LINKS_ENABLED: 'true' };
  const policy = (config = env) => createMailSecurityPolicy(() => collection, config);

  test('ERP default is limited to the existing explicit CW01 opt-in', async () => {
    expect((await policy().read()).trustedOrigins).toEqual(['https://erp.rzcloud.ch']);
    expect(
      (await policy({ ...env, MAIL_ASSISTANT_INSTANCE: 'cw02' }).read()).trustedOrigins,
    ).toEqual([]);
    expect(
      (await policy({ ...env, MAIL_ASSISTANT_ERP_LINKS_ENABLED: 'false' }).read()).trustedOrigins,
    ).toEqual([]);
  });
  test('explicit empty policy revokes even the legacy ERP default', async () => {
    await policy().write('initial', []);
    expect((await policy().read()).trustedOrigins).toEqual([]);
  });
  test('concurrent initial saves and stale revisions cannot overwrite a newer decision', async () => {
    const writes = await Promise.allSettled([
      policy().write('initial', ['https://erp.example.com']),
      policy().write('initial', ['https://portal.example.com']),
    ]);
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const current = await policy().read();
    const next = await policy().write(current.revision, []);
    await expect(policy().write(current.revision, ['https://old.example.com'])).rejects.toThrow();
    expect(await policy().read()).toEqual(next);
  });
  test('corrupt stored policies fail closed', async () => {
    await collection.insertOne({
      _id: 'instance',
      revision: 'bad',
      trustedOrigins: ['https://*.example.com'],
    });
    await expect(policy().read()).rejects.toThrow();
  });

  function app(authorized = true, auditWorks = true) {
    const audit = jest.fn().mockResolvedValue(auditWorks ? {} : null);
    const value = express();
    value.use(
      '/policy',
      createMailSecurityAdminRouter({
        collection: () => collection,
        env,
        authorize: async () => (authorized ? { id: 'admin' } : null),
        audit,
      }),
    );
    return { value, audit };
  }
  test('denies both policy reads and writes without authorization', async () => {
    const { value, audit } = app(false);
    await request(value).get('/policy').expect(403);
    await request(value)
      .put('/policy')
      .send({ revision: 'initial', trustedOrigins: [] })
      .expect(403);
    expect(audit).not.toHaveBeenCalled();
    expect(await collection.countDocuments()).toBe(0);
  });
  test.each([
    { revision: 'initial', trustedOrigins: ['http://erp.example.com'] },
    { revision: 'initial', trustedOrigins: ['https://127.0.0.1'] },
    { revision: 'initial', trustedOrigins: ['https://erp.example.com/path'] },
    { revision: 'initial', trustedOrigins: ['https://*.example.com'] },
    { revision: 'initial', trustedOrigins: ['https://erp.example.com'], enabled: true },
    { revision: 'initial', trustedOrigins: Array(33).fill('https://erp.example.com') },
    { revision: { $ne: 'initial' }, trustedOrigins: [] },
  ])('rejects unsafe or out-of-scope settings before mutation: %j', async (body) => {
    const { value, audit } = app();
    await request(value).put('/policy').send(body).expect(400);
    expect(audit).not.toHaveBeenCalled();
    expect(await collection.countDocuments()).toBe(0);
  });
  test('audit outage blocks updates, and replies cannot be cached', async () => {
    const { value } = app(true, false);
    const read = await request(value).get('/policy').expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    await request(value)
      .put('/policy')
      .send({ revision: 'initial', trustedOrigins: [] })
      .expect(409);
    expect(await collection.countDocuments()).toBe(0);
  });
  test('authorized update is audited before persisting and cannot toggle mail processing', async () => {
    const { value, audit } = app();
    const response = await request(value)
      .put('/policy')
      .send({ revision: 'initial', trustedOrigins: ['https://erp.example.com'] })
      .expect(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          event: 'trusted_origins_update_requested',
          origins: 'https://erp.example.com',
        }),
      }),
      { failClosed: true },
    );
    expect(response.body.trustedOrigins).toEqual(['https://erp.example.com']);
    expect(await policy().read()).toEqual(response.body);
    expect(response.body).not.toHaveProperty('enabled');
  });
});
