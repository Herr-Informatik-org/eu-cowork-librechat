import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db, Collection, CommandSucceededEvent } from 'mongodb';
import type { BrainHistoryJob, BrainHistoryMessage, BrainHistoryStore } from './historyStore';
import type { BrainStoredMessage } from './conversation';
import type { BrainHistoryProcessor } from './history';
import type { ServerRequest } from '~/types';
import { conversationMessages, conversationTranscript } from './conversation';
import { brainHistorySourceHash, createBrainHistoryService } from './history';
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
    client = await MongoClient.connect(server.getUri(), { monitorCommands: true });
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

  it('removes attachment and tool payloads in Mongo while preserving the exact visible transcript', async () => {
    const excluded = `synthetic-excluded-payload:${'x'.repeat(50000)}`;
    const originals: BrainStoredMessage[] = [
      {
        messageId: 'structured',
        conversationId: 'own',
        isCreatedByUser: true,
        createdAt: new Date(1000),
        parentMessageId: null,
        text: 'Unused fallback.',
        content: [
          { type: 'text', text: { value: 'Erste Zeile.', ignored: excluded }, ignored: excluded },
          { type: 'tool_call', tool_call: { output: excluded } },
          { type: 'image_url', image_url: { url: excluded } },
          { type: 'text', text: 'Zweite Zeile.' },
        ],
      },
      {
        messageId: 'fallback',
        conversationId: 'own',
        isCreatedByUser: false,
        createdAt: new Date(2000),
        parentMessageId: 'structured',
        text: 'Unveränderter Fallback.',
        content: [null, { type: 'text', text: 42 }, { type: 'file', file: excluded }],
      },
      {
        messageId: 'empty',
        conversationId: 'own',
        isCreatedByUser: false,
        createdAt: new Date(2000),
        text: 'Dieser Fallback darf nicht erscheinen.',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_call', output: excluded },
        ],
      },
      {
        messageId: 'plain',
        conversationId: 'own',
        isCreatedByUser: true,
        createdAt: new Date(2000),
        parentMessageId: 'fallback',
        text: 'Ja, nur für Atlas.',
      },
    ];
    await database.collection('conversations').insertOne({ user: 'owner', conversationId: 'own' });
    await database
      .collection('messages')
      .insertMany(originals.map((message) => ({ ...message, user: 'owner' })));
    const returned: string[] = [];
    const capture = (event: CommandSucceededEvent) => {
      const reply = event.reply;
      if (!reply || typeof reply !== 'object' || !('cursor' in reply)) return;
      const cursor = reply.cursor;
      if (!cursor || typeof cursor !== 'object' || !('ns' in cursor) || !('firstBatch' in cursor))
        return;
      if (
        event.commandName === 'aggregate' &&
        cursor.ns === `${database.databaseName}.messages` &&
        Array.isArray(cursor.firstBatch)
      )
        returned.push(JSON.stringify(cursor.firstBatch));
    };
    client.on('commandSucceeded', capture);
    try {
      const chat = await store.conversation!('owner', 'own', new Date());
      const expected = conversationMessages(originals);
      expect(chat?.messages).toEqual(expected);
      expect(chat?.text).toBe(conversationTranscript(expected));
      expect(chat?.createdAt).toEqual(new Date(1000));
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.some((batch) => batch.includes('synthetic-excluded-payload'))).toBe(false);
      expect(returned.some((batch) => batch.includes('tool_call'))).toBe(false);
      expect(returned.some((batch) => batch.includes('image_url'))).toBe(false);
    } finally {
      client.off('commandSucceeded', capture);
    }
  });

  it.each(['message-count', 'message-length'] as const)(
    'resumes a persisted v2 %s failure after 136 finished chats without resetting its generation',
    async (limit) => {
      const chatId = (index: number) => `chat-${String(index).padStart(4, '0')}`;
      const cutoff = new Date(1_000_000);
      const earlier = Array.from({ length: 136 }, (_, index) => ({
        user: 'owner',
        conversationId: chatId(index + 1),
        messageId: `finished-${index + 1}`,
        createdAt: new Date(index + 1),
        isCreatedByUser: true,
        text: 'Bereits ausgewerteter Chat.',
      }));
      const large = Array.from({ length: limit === 'message-count' ? 2001 : 1 }, (_, index) => ({
        user: 'owner',
        conversationId: chatId(137),
        messageId: `large-${index}`,
        createdAt: new Date(10_000 + index),
        isCreatedByUser: index % 2 === 0,
        text: limit === 'message-length' ? 'x'.repeat(120001) : `Gesprächsbeitrag ${index}.`,
      }));
      await database.collection('conversations').insertMany(
        Array.from({ length: 138 }, (_, index) => ({
          user: 'owner',
          conversationId: chatId(index + 1),
        })),
      );
      await database.collection('messages').insertMany([
        ...earlier,
        ...large,
        {
          user: 'owner',
          conversationId: chatId(138),
          messageId: 'next',
          createdAt: new Date(20_000),
          isCreatedByUser: true,
          text: 'Der nächste Chat.',
        },
      ]);
      const pending = (await store.conversation!('owner', chatId(137), cutoff))!;
      const cursor = { createdAt: new Date(136), messageId: chatId(136) };
      await jobs.insertOne({
        ...initial(),
        schemaVersion: 2,
        rebuildId: 'existing-draft',
        status: 'failed',
        analysisFingerprint: 'unchanged-model-and-context',
        revision: 19,
        cutoff,
        cursor,
        processed: 136,
        total: 138,
        saved: 217,
        skipped: 19,
        processedSections: 164,
        error: 'Dieser Chat überschreitet die sichere Importgrösse.',
        pending: {
          message: {
            conversationId: pending.conversationId,
            messageId: pending.messageId,
            createdAt: pending.createdAt,
          },
          sourceHash: brainHistorySourceHash(pending.text),
          offset: 0,
          end: pending.text.length,
          saved: 0,
        },
      });
      const extracted: BrainHistoryMessage[] = [];
      const generations: (string | undefined)[] = [];
      const completed: string[] = [];
      const processor: BrainHistoryProcessor = {
        availability: async () => ({
          available: true,
          analysisFingerprint: 'unchanged-model-and-context',
        }),
        chunk: async (_req, source) => source.text.length,
        extract: async (input) => {
          expect(await input.canContinue()).toBe(true);
          expect(input.review).toBeUndefined();
          extracted.push(input.source);
          await input.onReview!({ position: 1, candidates: [], phase: 'extract' });
          await input.onFacts([
            {
              text: 'Geprüfte synthetische Erinnerung.',
              quote: input.source.messages![0].text,
              kind: 'fact',
            },
          ]);
          await input.onBilling('started');
          await input.onBilling('complete');
        },
        ingest: async (input) => {
          expect(await input.canContinue()).toBe(true);
          generations.push(input.rebuildId);
          return 1;
        },
        complete: async (_req, rebuildId) => {
          completed.push(rebuildId);
        },
      };
      const service = createBrainHistoryService({ store, processor });
      const request = { user: { id: 'owner' } } as ServerRequest;
      expect(await service.start(request)).toMatchObject({
        status: 'running',
        processed: 136,
        total: 138,
        saved: 217,
        rebuildId: 'existing-draft',
      });
      await service.settle('owner');
      expect(extracted.map((source) => source.conversationId)).toEqual([chatId(137), chatId(138)]);
      expect(extracted[0].messages).toEqual(pending.messages);
      expect(extracted[0].text).toBe(pending.text);
      expect(generations).toEqual(['existing-draft', 'existing-draft']);
      expect(completed).toEqual(['existing-draft']);
      expect(await store.read('owner')).toMatchObject({
        schemaVersion: 2,
        rebuildId: 'existing-draft',
        status: 'completed',
        cutoff,
        analysisFingerprint: 'unchanged-model-and-context',
        processed: 138,
        total: 138,
        saved: 219,
        skipped: 19,
        processedSections: 166,
        cursor: { messageId: chatId(138), createdAt: new Date(20_000) },
      });
      expect((await store.read('owner'))?.pending).toBeUndefined();
    },
  );

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
