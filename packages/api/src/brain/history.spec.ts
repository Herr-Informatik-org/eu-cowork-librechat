import type { ServerRequest } from '~/types';
import type { BrainHistoryJob, BrainHistoryMessage, BrainHistoryStore } from './historyStore';
import type { BrainHistoryProcessor } from './history';
import { createBrainHistoryService } from './history';

const req = { user: { id: 'owner' }, body: { model: 'untrusted-model' } } as ServerRequest;
const source = (index: number): BrainHistoryMessage => ({
  messageId: `message-${String(index).padStart(4, '0')}`,
  conversationId: 'personal-chat',
  createdAt: new Date(1000 + index),
  text: `Projekt ${index} verwendet einen Freigabeprozess mit zwei Personen.`,
});

function fixture(messages = [source(1)]) {
  let job: BrainHistoryJob | null = null;
  const store: BrainHistoryStore = {
    read: jest.fn(async () => (job ? structuredClone(job) : null)),
    create: jest.fn(async (initial) => {
      job ??= structuredClone(initial);
    }),
    claim: jest.fn(async (owner, revision, token, until) => {
      if (!job || job.ownerId !== owner || job.revision !== revision || job.status === 'running')
        return null;
      job = {
        ...job,
        status: 'running',
        leaseToken: token,
        leaseUntil: until,
        pauseRequested: false,
        revision: revision + 1,
      };
      return structuredClone(job);
    }),
    update: jest.fn(async (owner, token, fields) => {
      if (!job || job.ownerId !== owner || job.leaseToken !== token || job.status !== 'running')
        return false;
      job = { ...job, ...structuredClone(fields), revision: job.revision + 1 };
      return true;
    }),
    pause: jest.fn(async () => {
      if (job) job.pauseRequested = true;
    }),
    expire: jest.fn(async (_owner, now, error) => {
      if (job?.status === 'running' && job.leaseUntil && job.leaseUntil <= now) {
        job = {
          ...job,
          status: 'paused',
          leaseToken: undefined,
          error,
          revision: job.revision + 1,
        };
      }
    }),
    count: jest.fn(
      async (_owner, cursor, cutoff) =>
        messages.filter(
          (message) =>
            message.createdAt <= cutoff &&
            (!cursor ||
              message.createdAt > cursor.createdAt ||
              (message.createdAt.getTime() === cursor.createdAt.getTime() &&
                message.messageId > cursor.messageId)),
        ).length,
    ),
    next: jest.fn(
      async (_owner, cursor, cutoff) =>
        messages.find(
          (message) =>
            message.createdAt <= cutoff &&
            (!cursor ||
              message.createdAt > cursor.createdAt ||
              (message.createdAt.getTime() === cursor.createdAt.getTime() &&
                message.messageId > cursor.messageId)),
        ) ?? null,
    ),
    source: jest.fn(
      async (_owner, id, conversationId) =>
        messages.find(
          (message) => message.messageId === id && message.conversationId === conversationId,
        ) ?? null,
    ),
  };
  const processor: jest.Mocked<BrainHistoryProcessor> = {
    availability: jest.fn<
      ReturnType<BrainHistoryProcessor['availability']>,
      Parameters<BrainHistoryProcessor['availability']>
    >(async () => ({ available: true, modelLabel: 'configured learning model' })),
    chunk: jest.fn<
      ReturnType<BrainHistoryProcessor['chunk']>,
      Parameters<BrainHistoryProcessor['chunk']>
    >(async (_req, message) => message.text.length),
    extract: jest.fn(async ({ text, onFacts, onBilling }) => {
      await onFacts([{ quote: text, kind: 'fact' }]);
      await onBilling('started');
      await onBilling('complete');
    }),
    ingest: jest.fn<
      ReturnType<BrainHistoryProcessor['ingest']>,
      Parameters<BrainHistoryProcessor['ingest']>
    >(async () => 1),
  };
  const service = createBrainHistoryService({ store, processor });
  return {
    store,
    processor,
    service,
    getJob: () => job,
    deleteJob: () => {
      job = null;
    },
    setJob: (value: BrainHistoryJob) => {
      job = value;
    },
  };
}

describe('durable personal Brain history', () => {
  it('processes all 205 chronological user messages and then incrementally only new messages', async () => {
    const messages = Array.from({ length: 205 }, (_, index) => source(index));
    const { service, processor, store } = fixture(messages);
    expect(await service.status(req)).toMatchObject({ status: 'idle', processed: 0 });
    expect(await service.start(req)).toMatchObject({ status: 'running', total: 205 });
    await service.settle('owner');
    expect(await service.status(req)).toMatchObject({
      status: 'completed',
      total: 205,
      processed: 205,
      saved: 205,
    });
    expect(processor.extract).toHaveBeenCalledTimes(205);
    expect(processor.extract.mock.calls.map(([input]) => input.source.messageId)).toEqual(
      messages.map((message) => message.messageId),
    );
    expect(store.next).toHaveBeenCalledWith('owner', undefined, expect.any(Date));
    messages.push(source(206));
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(206);
    expect(await service.status(req)).toMatchObject({ processed: 206, saved: 206 });
  });

  it('claims a single worker for concurrent starts from separate API replicas', async () => {
    const { service, processor, store } = fixture();
    const second = createBrainHistoryService({ store, processor });
    await Promise.all([service.start(req), second.start(req)]);
    await Promise.all([service.settle('owner'), second.settle('owner')]);
    expect(processor.extract).toHaveBeenCalledTimes(1);
    expect(processor.ingest).toHaveBeenCalledTimes(1);
  });

  it('pauses after the active result and resumes without repeating its model call', async () => {
    const { service, processor } = fixture([source(1), source(2)]);
    const original = processor.extract.getMockImplementation()!;
    processor.extract.mockImplementationOnce(async (input) => {
      await service.pause(req);
      await original(input);
    });
    await service.start(req);
    await service.settle('owner');
    expect(await service.status(req)).toMatchObject({ status: 'paused', processed: 1 });
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(2);
    expect(await service.status(req)).toMatchObject({ status: 'completed', processed: 2 });
  });

  it('retries durable ingestion after a Brain outage without a new extraction or charge', async () => {
    const { service, processor } = fixture();
    processor.ingest.mockRejectedValueOnce(new Error('synthetic transport failure'));
    await service.start(req);
    await service.settle('owner');
    expect(await service.status(req)).toMatchObject({ status: 'failed', processed: 0, saved: 0 });
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(1);
    expect(processor.ingest).toHaveBeenCalledTimes(2);
    expect(await service.status(req)).toMatchObject({
      status: 'completed',
      processed: 1,
      saved: 1,
    });
  });

  it('surfaces uncertain accounting after restart and reuses the extraction instead of billing twice', async () => {
    const { service, processor } = fixture();
    processor.extract.mockImplementationOnce(async ({ text, onFacts, onBilling }) => {
      await onFacts([{ quote: text, kind: 'fact' }]);
      await onBilling('started');
      throw new Error('interrupted booking');
    });
    await service.start(req);
    await service.settle('owner');
    const resumed = await service.start(req);
    expect(resumed.error).toMatch(/Kostenbuchung.*nicht automatisch wiederholt/);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(1);
    expect(await service.status(req)).toMatchObject({
      status: 'completed',
      processed: 1,
      error: expect.stringContaining('Administration'),
    });
  });

  it('does not recreate a deleted job when an in-flight provider completes', async () => {
    const { service, processor, deleteJob, getJob } = fixture();
    processor.extract.mockImplementationOnce(async ({ onFacts }) => {
      deleteJob();
      await onFacts([{ quote: 'Original fact', kind: 'fact' }]);
    });
    await service.start(req);
    await service.settle('owner');
    expect(getJob()).toBeNull();
    expect(processor.ingest).not.toHaveBeenCalled();
  });

  it('blocks persistence when opt-out changes during the provider call and stops further messages', async () => {
    const { service, processor } = fixture([source(1), source(2)]);
    processor.extract.mockImplementationOnce(async ({ onFacts, text }) => {
      await onFacts([{ quote: text, kind: 'fact' }]);
      processor.availability.mockResolvedValue({
        available: false,
        reason: 'Erinnerungen sind ausgeschaltet.',
      });
    });
    await service.start(req);
    await service.settle('owner');
    expect(processor.ingest).not.toHaveBeenCalled();
    expect(await service.status(req)).toMatchObject({
      status: 'failed',
      processed: 0,
      available: false,
    });
  });

  it('discards a deleted source checkpoint on resume without reusing its fact', async () => {
    const messages = [source(1), source(2)];
    const { service, processor } = fixture(messages);
    processor.ingest.mockRejectedValueOnce(new Error('outage'));
    await service.start(req);
    await service.settle('owner');
    messages.shift();
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(2);
    expect(await service.status(req)).toMatchObject({
      status: 'completed',
      processed: 2,
      saved: 1,
      skipped: 1,
    });
  });

  it('counts one long message once across bounded chunks and resumes from the chunk offset', async () => {
    const { service, processor } = fixture([{ ...source(1), text: 'abcdefghijklmno' }]);
    processor.chunk.mockImplementation(async (_req, message, offset) =>
      Math.min(message.text.length, offset + 5),
    );
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract.mock.calls.map(([input]) => input.text)).toEqual([
      'abcde',
      'fghij',
      'klmno',
    ]);
    expect(await service.status(req)).toMatchObject({ processed: 1, total: 1, saved: 3 });
  });

  it('exposes an expired worker as paused and requires a deliberate resume', async () => {
    const { service, processor, setJob } = fixture();
    setJob({
      _id: 'owner',
      ownerId: 'owner',
      status: 'running',
      revision: 1,
      total: 1,
      processed: 0,
      skipped: 0,
      saved: 0,
      cutoff: new Date(),
      leaseToken: 'old',
      leaseUntil: new Date(0),
    });
    expect(await service.status(req)).toMatchObject({
      status: 'paused',
      error: expect.stringContaining('unterbrochen'),
    });
    expect(processor.extract).not.toHaveBeenCalled();
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract).toHaveBeenCalledTimes(1);
  });

  it('recalculates an unfinished chunk for a smaller model selected before resume', async () => {
    const { service, processor } = fixture([{ ...source(1), text: 'abcdefghijklmno' }]);
    processor.extract.mockRejectedValueOnce(new Error('provider unavailable'));
    await service.start(req);
    await service.settle('owner');
    processor.chunk.mockImplementation(async (_req, message, offset) =>
      Math.min(message.text.length, offset + 5),
    );
    await service.start(req);
    await service.settle('owner');
    expect(processor.extract.mock.calls.map(([input]) => input.text)).toEqual([
      'abcdefghijklmno',
      'abcde',
      'fghij',
      'klmno',
    ]);
    expect(await service.status(req)).toMatchObject({ status: 'completed', processed: 1 });
  });
});
