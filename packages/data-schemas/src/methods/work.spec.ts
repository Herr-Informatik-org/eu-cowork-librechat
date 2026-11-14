import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { deleteOwnedWorkData, syncOwnedWorkExpiry } from './work';
let server: MongoMemoryServer;
let conversationId: string;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'private_work_lifecycle' });
}, 60000);
beforeEach(async () => {
  conversationId = randomUUID();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
it('removes owned chat copies and scrubs uncertain effects while keeping other owners intact', async () => {
  const db = mongoose.connection.db!;
  const own = { userId: 'owner-a', conversationId },
    other = { userId: 'owner-b', conversationId };
  for (const name of [
    'eucowork_work_outputs',
    'eucowork_work_customers',
    'eucowork_safe_work_tasks',
  ])
    await db.collection(name).insertMany([
      { ...own, contentEnc: 'private' },
      { ...other, contentEnc: 'other' },
    ]);
  await db.collection('eucowork_safe_work_records').insertMany([
    { ...own, state: 'verified' },
    {
      ...own,
      state: 'uncertain',
      valuesEnc: 'sensitive-target',
      history: ['private'],
      barrier: 'keep',
    },
    { ...other, state: 'uncertain', valuesEnc: 'other' },
  ]);
  await db.collection('eucowork_safe_work_effects').insertMany([
    { ...own, state: 'verified', resultEnc: 'private' },
    { ...own, state: 'attempted', barrier: 'keep' },
  ]);
  await deleteOwnedWorkData(mongoose.connection, own.userId, [conversationId]);
  expect(await db.collection('eucowork_work_outputs').countDocuments(own)).toBe(0);
  expect(await db.collection('eucowork_work_outputs').countDocuments(other)).toBe(1);
  const barrier = await db.collection('eucowork_safe_work_records').findOne({ barrier: 'keep' });
  expect(barrier?.state).toBe('uncertain');
  expect(barrier?.userId).toBeUndefined();
  expect(barrier?.conversationId).toBeUndefined();
  expect(barrier?.valuesEnc).toBeUndefined();
  expect(barrier?.history).toBeUndefined();
  expect(await db.collection('eucowork_safe_work_records').countDocuments(other)).toBe(1);
});
it('extends owned source lifetime when a temporary chat becomes permanent and honours shortening', async () => {
  const db = mongoose.connection.db!,
    expiresAt = new Date(Date.now() + 3600000);
  for (const name of [
    'eucowork_work_outputs',
    'eucowork_work_customers',
    'eucowork_safe_work_tasks',
  ])
    await db.collection(name).insertMany([
      { userId: 'owner-a', conversationId, expiresAt },
      { userId: 'owner-b', conversationId, expiresAt },
    ]);
  await syncOwnedWorkExpiry(mongoose.connection, 'owner-a', conversationId, null);
  expect(
    (await db.collection('eucowork_work_outputs').findOne({ userId: 'owner-a', conversationId }))
      ?.expiresAt,
  ).toBeNull();
  expect(
    (await db.collection('eucowork_work_outputs').findOne({ userId: 'owner-b', conversationId }))
      ?.expiresAt,
  ).toEqual(expiresAt);
  await syncOwnedWorkExpiry(mongoose.connection, 'owner-a', conversationId, expiresAt);
  expect(
    (await db.collection('eucowork_work_outputs').findOne({ userId: 'owner-a', conversationId }))
      ?.expiresAt,
  ).toEqual(expiresAt);
});
