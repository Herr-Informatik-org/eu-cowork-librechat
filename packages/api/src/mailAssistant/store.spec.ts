import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db } from 'mongodb';
import { createMongoMailStore } from './store';
import { createMailCodec } from './privateData';
import { defaultMailSettings } from './schedule';
import type { StoredMailResult } from './types';

describe('personal mail durable lease and retention', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  const codec = createMailCodec('ab'.repeat(32));
  const settings = {
    ...defaultMailSettings(),
    enabled: true,
    mode: 'scheduled' as const,
    consentVersion: '2026-10-25',
  };
  const result: StoredMailResult = {
    id: 'a'.repeat(64),
    messageId: 'private-message-id',
    conversationId: 'private-thread',
    sourceHash: 'hash',
    subject: 'Confidential subject',
    sender: 'private@example.invalid',
    receivedAt: new Date().toISOString(),
    priority: 'normal',
    action: 'review',
    summary: 'Confidential summary',
    reason: 'Confidential reason',
    questions: ['Private question'],
    draftStatus: 'none',
    categoryApplied: false,
  };
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('mail_store_test');
  }, 120000);
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await db.dropDatabase();
  });
  const store = () =>
    createMongoMailStore({
      collection: () => db.collection('jobs'),
      operations: () => db.collection('operations'),
      codec,
    });
  test('only one replica claims a personal job', async () => {
    const a = store();
    const b = store();
    await a.saveSettings('alice', settings, new Date());
    const claims = await Promise.all([
      a.claim('alice', 'one', new Date()),
      b.claim('alice', 'two', new Date()),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  test('changing enabled settings invalidates the old lease atomically', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'old', new Date());
    await s.saveSettings('alice', { ...settings, startTime: '09:00' }, new Date());
    expect(await s.update('alice', 'old', { lastError: 'must not write' })).toBe(false);
    await expect(s.putResult('alice', 'old', result)).rejects.toThrow();
    await s.release('alice', 'old', { nextRunAt: 'must not replace schedule' });
    expect((await s.read('alice'))?.nextRunAt).not.toBe('must not replace schedule');
  });
  test('scheduler excludes running jobs but recovers expired leases', async () => {
    const s = store();
    const now = new Date('2026-10-26T08:00:00Z');
    await s.saveSettings('alice', settings, now);
    await s.saveSettings('bob', settings, now);
    await s.claim('alice', 'manual-worker', now);
    expect(await s.due(now)).toEqual(['bob']);
    expect(await s.due(new Date(now.getTime() + 121000))).toEqual(['alice', 'bob']);
  });
  test('every result write enforces the 200 item content limit', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'token', new Date());
    for (let i = 0; i < 205; i++)
      await s.putResult('alice', 'token', { ...result, id: i.toString(16).padStart(64, '0') });
    const row = await db.collection('jobs').findOne({ ownerId: 'alice' });
    expect(Object.keys(row?.results ?? {})).toHaveLength(200);
    expect(await s.results('alice')).toHaveLength(200);
  });
  test('pause and purge never allow a late worker to recreate results', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'old', new Date());
    await s.pause('alice');
    expect(await s.update('alice', 'old', {})).toBe(false);
    await s.purge('alice');
    await expect(s.putResult('alice', 'old', result)).rejects.toThrow();
    await s.release('alice', 'old', {});
    expect(await s.read('alice')).toBeNull();
  });
  test('encrypts checkpoints and results, rejects cross-account retrieval', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'token', new Date());
    await s.putResult('alice', 'token', result);
    await s.update('alice', 'token', {
      checkpoint: { pending: ['private-message-id'], url: 'private-cursor' },
    });
    const serialized = JSON.stringify(await db.collection('jobs').findOne({ ownerId: 'alice' }));
    for (const secret of [
      'Confidential',
      'private-message-id',
      'private-cursor',
      'Private question',
    ])
      expect(serialized).not.toContain(secret);
    expect(await s.result('bob', result.id)).toBeNull();
    expect(await s.results('bob')).toEqual([]);
    expect(await s.result('alice', result.id)).toEqual(result);
  });
  test('expired results are deleted even for a paused user, settings remain', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'token', new Date());
    await s.putResult('alice', 'token', result);
    await s.pause('alice');
    await s.prune(new Date(Date.now() + 31 * 86400000));
    expect(await s.results('alice')).toEqual([]);
    expect((await s.read('alice'))?.settings.enabled).toBe(false);
    const row = await db.collection('jobs').findOne({ ownerId: 'alice' });
    expect(row?.results).toEqual({});
  });
  test('uncertain creation marker survives settings edits and another lease', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'one', new Date());
    await s.putResult('alice', 'one', {
      ...result,
      operationPending: true,
      draftStatus: 'uncertain',
    });
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'two', new Date());
    expect((await s.result('alice', result.id))?.operationPending).toBe(true);
  });
  test('durable no-content draft barrier survives result pruning and is removed on disconnect', async () => {
    const s = store();
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'one', new Date());
    expect(await s.reserveDraft('alice', 'one', result.id, 'source')).toBe(true);
    await s.prune(new Date(Date.now() + 31 * 86400000));
    expect(await s.reserveDraft('alice', 'one', result.id, 'source')).toBe(false);
    expect(await s.reserveDraft('alice', 'one', result.id, 'new-source')).toBe(false);
    await s.finishDraft('alice', result.id, 'source', 'completed');
    expect(await s.reserveDraft('alice', 'one', result.id, 'source')).toBe(false);
    expect(await s.reserveDraft('alice', 'one', result.id, 'new-source')).toBe(true);
    expect(await s.draftState('bob', result.id)).toBeNull();
    await s.purge('alice');
    await s.finishDraft('alice', result.id, 'new-source', 'completed');
    expect(await s.draftState('alice', result.id)).toBeNull();
  });
  test('disconnect between lease read and draft reservation cannot recreate metadata', async () => {
    const jobs = db.collection<any>('jobs');
    const s = createMongoMailStore({
      collection: () => jobs,
      operations: () => db.collection('operations'),
      codec,
    });
    await s.saveSettings('alice', settings, new Date());
    await s.claim('alice', 'token', new Date());
    const original = jobs.findOne.bind(jobs);
    jest.spyOn(jobs, 'findOne').mockImplementationOnce(async (filter: any) => {
      const row = await original(filter);
      await s.purge('alice');
      return row;
    });
    expect(await s.reserveDraft('alice', 'token', result.id, 'source')).toBe(false);
    expect(await db.collection('operations').countDocuments({ ownerId: 'alice' })).toBe(0);
  });
});
