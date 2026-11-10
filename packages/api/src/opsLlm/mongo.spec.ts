import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createOpsStore } from './store';
import { readOpsConfig } from './config';

test('Mongo CAS quotas and expiry index match the real database contract', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const db = client.db('ops_llm_test');
    const store = createOpsStore((name) => db.collection(name));
    const issued = await store.create({ name: 'Synthetic test', modules: ['mail'] });
    const limits = { ...readOpsConfig({}).limits, parallel: 2, globalParallel: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.reserve(issued.record.id, limits)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const second = await store.reserve('other-key', limits);
    await expect(store.reserve('third-key', limits)).rejects.toMatchObject({ status: 429 });
    for (const result of results) if (result.status === 'fulfilled') await result.value();
    await second();
    expect(
      (
        await db
          .collection<{ _id: string; leases: { id: string }[] }>('eucowork_ops_llm_quota')
          .findOne({ _id: 'cwv01' })
      )?.leases,
    ).toHaveLength(0);
    await store.meter({
      key: issued.record.id,
      module: 'mail',
      model: null,
      status: 'error',
      errorCode: 'request_aborted',
      input: null,
      output: null,
      durationMs: 10,
    });
    const indexes = await db.collection('eucowork_ops_llm_usage').indexes();
    expect(indexes.find((index) => index.name === 'expiresAt_1')?.expireAfterSeconds).toBe(0);
    expect(
      JSON.stringify(await db.collection('eucowork_ops_llm_keys').find({}).toArray()),
    ).not.toContain(issued.key);
  } finally {
    await client.close();
    await server.stop();
  }
}, 60000);
