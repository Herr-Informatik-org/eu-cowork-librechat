import type { Collection, Document } from 'mongodb';
import type { BrainSession } from './session';
import { createMongoBrainLearningStore, trackBrainLearning } from './status';
import { BrainOperationError } from './diagnostics';

const run = {
  id: 'run',
  ownerId: 'owner',
  conversationId: 'chat',
  sourceMessageId: 'source',
  sourceCreatedAt: '2026-10-27T11:59:00Z',
  messageId: 'response',
};
function setup() {
  const collection = {
    createIndex: jest.fn(async () => ''),
    insertOne: jest.fn(async () => ({})),
    updateOne: jest.fn(async () => ({})),
    findOne: jest.fn(),
    deleteOne: jest.fn(async () => ({})),
  };
  const now = new Date('2026-10-27T12:00:00Z');
  const store = createMongoBrainLearningStore(
    () => collection as unknown as Collection<Document>,
    () => now,
  );
  return { collection, store, now };
}
it('persists only run metadata, expires after 30 days, and never upserts a deleted status', async () => {
  const { collection, store, now } = setup();
  await store.start(run);
  await store.finish(run, { status: 'completed', saved: 2 });
  expect(collection.insertOne).toHaveBeenCalledWith({
    ...run,
    status: 'running',
    saved: 0,
    startedAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 86400_000),
  });
  expect(collection.updateOne).toHaveBeenCalledWith(
    { id: 'run', ownerId: 'owner', status: 'running' },
    { $set: { status: 'completed', saved: 2, updatedAt: now } },
  );
});
it('reports stale workers after a restart as interrupted and always filters the owner', async () => {
  const { collection, store, now } = setup();
  collection.findOne.mockResolvedValue({
    ...run,
    status: 'running',
    saved: 0,
    startedAt: now,
    updatedAt: new Date(now.getTime() - 121000),
  });
  expect((await store.latest('owner', 'chat')).status).toBe('interrupted');
  expect(collection.findOne).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: 'owner', conversationId: 'chat' }),
    { sort: { startedAt: -1 } },
  );
});
it('records a real successful completion and an actionable failure without raw model error text', async () => {
  const { collection, store } = setup();
  const session = {
    options: { ...run, userId: 'owner', source: { id: 'source', text: 'private source' } },
  } as unknown as BrainSession;
  const reportFailure = jest.fn(async () => {});
  await trackBrainLearning({
    session,
    store,
    reportFailure,
    action: async () => ({ status: 'completed', saved: 2 }),
  });
  expect(collection.updateOne).toHaveBeenCalledWith(expect.anything(), {
    $set: expect.objectContaining({ status: 'completed', saved: 2 }),
  });
  await trackBrainLearning({
    session,
    store,
    reportFailure,
    action: async () => {
      throw new BrainOperationError('raw private source', 'review_missing_capture');
    },
  });
  expect(collection.updateOne).toHaveBeenLastCalledWith(expect.anything(), {
    $set: expect.objectContaining({ status: 'failed', errorCode: 'review_missing_capture' }),
  });
  expect(JSON.stringify(collection.updateOne.mock.calls)).not.toContain('raw private source');
});
it('marks superseded learning interrupted instead of accepting a late success', async () => {
  const { collection, store } = setup();
  const abort = new AbortController();
  const session = {
    options: { ...run, userId: 'owner', source: { id: 'source' }, signal: abort.signal },
  } as unknown as BrainSession;
  await trackBrainLearning({
    session,
    store,
    reportFailure: jest.fn(),
    action: async () => {
      abort.abort();
      return { status: 'completed', saved: 7 };
    },
  });
  for (const call of collection.updateOne.mock.calls) {
    expect(call).toEqual([
      expect.anything(),
      { $set: expect.objectContaining({ status: 'interrupted' }) },
    ]);
  }
});

it('removes a status inserted after its source was deleted during startup', async () => {
  const { collection, store } = setup();
  const session = {
    options: { ...run, userId: 'owner', source: { id: 'source' }, canPersist: async () => false },
  } as unknown as BrainSession;
  const action = jest.fn();
  await trackBrainLearning({ session, store, action, reportFailure: jest.fn() });
  expect(collection.insertOne).toHaveBeenCalledTimes(1);
  expect(collection.deleteOne).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }));
  expect(action).not.toHaveBeenCalled();
});
it('checks the source tombstone after inserting a run, including the account cutoff', async () => {
  const { collection, now } = setup();
  const tombstones = { findOne: jest.fn(async () => ({ key: 'user' })) };
  const store = createMongoBrainLearningStore(
    () => collection as unknown as Collection<Document>,
    () => now,
    () => tombstones as unknown as Collection<Document>,
  );
  await store.start(run);
  expect(collection.deleteOne).toHaveBeenCalledWith({ id: 'run', ownerId: 'owner' });
  expect(tombstones.findOne).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerId: 'owner',
      $or: expect.arrayContaining([{ key: 'user', deletedAt: { $gte: run.sourceCreatedAt } }]),
    }),
  );
});
