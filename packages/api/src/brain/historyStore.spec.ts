import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db, Collection } from 'mongodb';
import type { BrainHistoryJob, BrainHistoryStore } from './historyStore';
import { createMongoBrainHistoryStore } from './historyStore';

describe('Brain history Mongo ownership and lifecycle boundaries', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let database: Db;
  let jobs: Collection<BrainHistoryJob>;
  let store: BrainHistoryStore;

  const initial = (): BrainHistoryJob => ({
    _id: 'owner',
    ownerId: 'owner',
    status: 'idle',
    revision: 0,
    total: 0,
    processed: 0,
    skipped: 0,
    saved: 0,
    cutoff: new Date(),
  });

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    database = client.db('brain_history_synthetic_tests');
    jobs = database.collection<BrainHistoryJob>('eucowork_brain_history');
  });

  beforeEach(async () => {
    await database.dropDatabase();
    store = createMongoBrainHistoryStore({
      jobs: () => jobs,
      messages: () => database.collection('messages'),
      tombstones: () => database.collection('eucowork_brain_tombstones'),
    });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  async function seed() {
    await database.collection('conversations').insertMany([
      { user: 'owner', conversationId: 'own' },
      { user: 'foreign', conversationId: 'foreign' },
      { user: 'owner', conversationId: 'temporary', isTemporary: true },
      { user: 'owner', conversationId: 'expiring', expiredAt: new Date(Date.now() + 10000) },
    ]);
    await database.collection('messages').insertMany([
      {
        messageId: 'a',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        text: 'Eligible own user statement A.',
      },
      {
        messageId: 'b',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        text: 'Eligible own user statement B.',
      },
      {
        messageId: 'assistant',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: false,
        createdAt: new Date(1000),
        text: 'Assistant assertion.',
      },
      {
        messageId: 'foreign',
        user: 'foreign',
        conversationId: 'foreign',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        text: 'Foreign user assertion.',
      },
      {
        messageId: 'foreign-parent',
        user: 'owner',
        conversationId: 'foreign',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        text: 'Wrong parent ownership.',
      },
      {
        messageId: 'orphan',
        user: 'owner',
        conversationId: 'deleted',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        text: 'Deleted conversation.',
      },
      {
        messageId: 'temporary-message',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: true,
        isTemporary: true,
        createdAt: new Date(1000),
      },
      {
        messageId: 'temporary-parent',
        user: 'owner',
        conversationId: 'temporary',
        isCreatedByUser: true,
        createdAt: new Date(1000),
      },
      {
        messageId: 'added',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: true,
        addedConvo: true,
        createdAt: new Date(1000),
      },
      {
        messageId: 'expired',
        user: 'owner',
        conversationId: 'own',
        isCreatedByUser: true,
        expiredAt: new Date(Date.now() + 10000),
        createdAt: new Date(1000),
      },
      {
        messageId: 'expired-parent',
        user: 'owner',
        conversationId: 'expiring',
        isCreatedByUser: true,
        createdAt: new Date(1000),
      },
    ]);
  }

  it('selects only personal persisted user messages and uses a stable equal-timestamp cursor', async () => {
    await seed();
    expect(await store.count('owner', undefined, new Date())).toBe(2);
    const first = await store.next('owner', undefined, new Date());
    expect(first?.messageId).toBe('a');
    const second = await store.next('owner', first!, new Date());
    expect(second?.messageId).toBe('b');
    expect(await store.next('owner', second!, new Date())).toBeNull();
    expect(await store.source('owner', 'foreign', 'foreign')).toBeNull();
    expect(await store.source('owner', 'foreign-parent', 'foreign')).toBeNull();
  });

  it('groups complete owned conversations including assistant context and structured text', async () => {
    await seed();
    await database.collection('messages').updateOne(
      { messageId: 'assistant' },
      {
        $set: {
          content: [
            { type: 'text', text: { value: 'Bezieht sich das auf Projekt Atlas?' } },
            { type: 'image_url', image_url: { url: 'excluded-attachment' } },
          ],
        },
      },
    );
    expect(await store.countConversations!('owner', undefined, new Date())).toBe(1);
    const chat = await store.nextConversation!('owner', undefined, new Date());
    expect(chat?.conversationId).toBe('own');
    expect(chat?.messages).toHaveLength(3);
    expect(chat?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'assistant',
          role: 'assistant',
          text: 'Bezieht sich das auf Projekt Atlas?',
        }),
      ]),
    );
    expect(chat?.text).not.toContain('excluded-attachment');
    expect(await store.nextConversation!('owner', chat!, new Date())).toBeNull();
    expect(await store.conversation!('owner', 'foreign', new Date())).toBeNull();
  });

  it('rechecks deleted context and edited source text for a whole conversation', async () => {
    await seed();
    const before = await store.conversation!('owner', 'own', new Date());
    await database
      .collection('messages')
      .updateOne({ messageId: 'a' }, { $set: { text: 'Corrected source.' } });
    const after = await store.conversation!('owner', 'own', new Date());
    expect(before?.text).not.toBe(after?.text);
    await database.collection('eucowork_brain_tombstones').insertOne({
      ownerId: 'owner',
      key: `source:${createHash('sha256').update('chat:own:assistant').digest('hex')}`,
      deletedAt: new Date().toISOString(),
    });
    expect(
      (await store.conversation!('owner', 'own', new Date()))?.messages?.map(
        (message) => message.id,
      ),
    ).toEqual(['a', 'b']);
  });

  it('replaces a legacy job while fencing its old worker and extraction checkpoint', async () => {
    await store.create(initial());
    await store.claim('owner', 0, 'old-worker', new Date(Date.now() + 10000));
    await store.resetConversationJob!({
      ...initial(),
      schemaVersion: 2,
      rebuildId: 'new-generation',
      revision: 2,
    });
    expect(await store.update('owner', 'old-worker', { saved: 100 })).toBe(false);
    expect(await store.read('owner')).toMatchObject({
      schemaVersion: 2,
      saved: 0,
      rebuildId: 'new-generation',
    });
  });

  it('keeps a running conversation checkpoint intact across concurrent draft start retries', async () => {
    const draft = { ...initial(), schemaVersion: 2 as const, rebuildId: 'draft' };
    await Promise.all([store.resetConversationJob!(draft), store.resetConversationJob!(draft)]);
    await store.claim('owner', 0, 'worker', new Date(Date.now() + 10000));
    await store.update('owner', 'worker', { processed: 7, saved: 3 });
    await Promise.all([store.resetConversationJob!(draft), store.resetConversationJob!(draft)]);
    expect(await store.read('owner')).toMatchObject({
      status: 'running',
      leaseToken: 'worker',
      processed: 7,
      saved: 3,
    });
  });

  it('does not pause a newer generation when discarding an old draft', async () => {
    await store.resetConversationJob!({ ...initial(), schemaVersion: 2, rebuildId: 'current' });
    await store.claim('owner', 0, 'worker', new Date(Date.now() + 10000));
    await store.pause('owner', 'old');
    expect((await store.read('owner'))?.pauseRequested).not.toBe(true);
    await store.pause('owner', 'current');
    expect((await store.read('owner'))?.pauseRequested).toBe(true);
  });

  it('honours source and conversation deletion fences before original documents disappear', async () => {
    await seed();
    const key = (kind: string, value: string) =>
      `${kind}:${createHash('sha256').update(value).digest('hex')}`;
    await database.collection('eucowork_brain_tombstones').insertOne({
      ownerId: 'owner',
      key: key('source', 'chat:own:a'),
      deletedAt: new Date().toISOString(),
    });
    expect(await store.source('owner', 'a', 'own')).toBeNull();
    expect((await store.next('owner', undefined, new Date()))?.messageId).toBe('b');
    await database.collection('eucowork_brain_tombstones').insertOne({
      ownerId: 'owner',
      key: key('conversation', 'own'),
      deletedAt: new Date().toISOString(),
    });
    expect(await store.next('owner', undefined, new Date())).toBeNull();
  });

  it('atomically admits one replica and rejects stale owner/token checkpoints', async () => {
    await store.create(initial());
    const claims = await Promise.all([
      store.claim('owner', 0, 'first', new Date(Date.now() + 10000)),
      store.claim('owner', 0, 'second', new Date(Date.now() + 10000)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.update('foreign', claims.find(Boolean)!.leaseToken!, { saved: 100 })).toBe(
      false,
    );
    expect(await store.update('owner', 'stale', { saved: 100 })).toBe(false);
    expect((await store.read('owner'))?.saved).toBe(0);
  });

  it('never recreates a removed job from a late heartbeat or model result', async () => {
    await store.create(initial());
    await store.claim('owner', 0, 'worker', new Date(Date.now() + 10000));
    await jobs.deleteOne({ ownerId: 'owner' });
    expect(await store.update('owner', 'worker', { saved: 1, leaseUntil: new Date() })).toBe(false);
    expect(await store.read('owner')).toBeNull();
  });

  it('fences old workers when pausing an expired lease and resuming with a new token', async () => {
    await store.create(initial());
    await store.claim('owner', 0, 'old', new Date(0));
    await store.expire('owner', new Date(), 'Unterbrochen.');
    const paused = await store.read('owner');
    expect(paused?.status).toBe('paused');
    expect(
      await store.claim('owner', paused!.revision, 'new', new Date(Date.now() + 10000)),
    ).not.toBeNull();
    expect(await store.update('owner', 'old', { saved: 12 })).toBe(false);
  });

  it('blocks a new job for an account already fenced for deletion', async () => {
    await database
      .collection('eucowork_brain_tombstones')
      .insertOne({ ownerId: 'owner', key: 'user', deletedAt: new Date().toISOString() });
    await expect(store.create(initial())).rejects.toThrow(/gelöscht/);
    expect(await store.read('owner')).toBeNull();
  });

  it('removes a just-created job if account deletion crosses the initial upsert', async () => {
    const original = jobs.updateOne.bind(jobs);
    const spy = jest.spyOn(jobs, 'updateOne').mockImplementationOnce(async (...args) => {
      await database
        .collection('eucowork_brain_tombstones')
        .insertOne({ ownerId: 'owner', key: 'user', deletedAt: new Date().toISOString() });
      return original(...args);
    });
    await expect(store.create(initial())).rejects.toThrow(/gelöscht/);
    spy.mockRestore();
    expect(await store.read('owner')).toBeNull();
  });

  it('creates the owner/cursor index once with the initial job', async () => {
    await store.create(initial());
    const indexes = await database.collection('messages').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'brain_history_owner_cursor',
          key: { user: 1, isCreatedByUser: 1, createdAt: 1, messageId: 1 },
        }),
      ]),
    );
  });
});
