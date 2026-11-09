import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { buildPendingAction, buildToolApprovalPayload } from '../agents/hitl/policy';
import { GenerationJobManagerClass } from '../stream/GenerationJobManager';
import { createStreamServices } from '../stream/createStreamServices';
import { createReleaseLifecycle } from './daytimeRelease';

const createRedisTestClient = (keyPrefix: string) =>
  new Redis(process.env.REDIS_URI || 'redis://127.0.0.1:6379', {
    keyPrefix,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

const describeRedis = process.env.KISUNO_TEST_REDIS === 'true' ? describe : describe.skip;

describeRedis('managed release locks on real Redis', () => {
  it('fences shared-tenant workers and keeps another tenant independent', async () => {
    const prefix = 'release-test-' + randomUUID() + ':';
    const redis = createRedisTestClient(prefix);
    const separate = createRedisTestClient(prefix + 'other:');
    await Promise.all([redis.connect(), separate.connect()]);
    const create = (id: string, client = redis) => {
      const lifecycle = createReleaseLifecycle({
        env: { KISUNO_RELEASE_ID: id },
        token: 'local-redis-test-control-token-long-enough',
      });
      lifecycle.configure({
        redis: client,
        checkRedis: async () => (await client.ping()) === 'PONG',
        generationSnapshot: async () => ({ jobs: 0, pending: 0, paused: 0 }),
      });
      lifecycle.registerWorker('test', { start: () => undefined, stop: () => undefined });
      lifecycle.markReady();
      return lifecycle;
    };
    const a = create('a');
    const b = create('b');
    const other = create('other', separate);
    try {
      await a.action('activate');
      await other.action('activate');
      await expect(b.action('activate')).rejects.toMatchObject({
        code: 'RELEASE_WORKERS_OWNED_ELSEWHERE',
      });
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const task = a.runTask(
        'worker',
        () => {
          entered();
          return pending;
        },
        { worker: true },
      );
      await started;
      await a.action('pause-workers');
      await expect(b.action('activate')).rejects.toMatchObject({
        code: 'RELEASE_WORKERS_OWNED_ELSEWHERE',
      });
      finish();
      await task;
      await a.snapshot();
      await b.action('activate');
      await a.action('drain');
      expect((await a.action('seal')).state).toBe('sealed');
      expect((await b.snapshot()).workersActive).toBe(true);
      expect((await other.snapshot()).workersActive).toBe(true);
      await b.action('drain');
      await b.action('seal');
      await other.action('drain');
      await other.action('seal');
    } finally {
      await Promise.all([
        redis.del('kisuno:release:workers:v1'),
        separate.del('kisuno:release:workers:v1'),
      ]);
      redis.disconnect();
      separate.disconnect();
    }
  });
  it('replays, aborts and transfers a human-review run across connected replicas without an offline queue', async () => {
    const prefix = 'release-stream-test-' + randomUUID() + ':';
    const publisher = createRedisTestClient(prefix);
    const subA = createRedisTestClient(prefix);
    const subB = createRedisTestClient(prefix);
    await Promise.all([publisher.connect(), subA.connect(), subB.connect()]);
    const a = new GenerationJobManagerClass();
    const b = new GenerationJobManagerClass();
    a.configure(
      createStreamServices({ useRedis: true, redisClient: publisher, redisSubscriber: subA }),
    );
    b.configure(
      createStreamServices({ useRedis: true, redisClient: publisher, redisSubscriber: subB }),
    );
    let unsubscribe: (() => void) | undefined;
    try {
      expect(a.isReleaseReady).toBe(true);
      expect(b.isReleaseReady).toBe(true);
      const job = await a.createJob('chat-a', 'user-a');
      expect((await b.getJob('chat-a'))?.createdAt).toBe(job.createdAt);
      let received!: () => void;
      const event = new Promise<void>((resolve) => {
        received = resolve;
      });
      unsubscribe = (await b.subscribe('chat-a', () => received()))?.unsubscribe;
      await a.emitChunk('chat-a', {
        event: 'on_message_delta',
        data: { id: 'step-a', delta: { content: { type: 'text', text: 'continued' } } },
      });
      await event;
      await b.abortJob('chat-a');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(job.abortController.signal.aborted).toBe(true);
      unsubscribe?.();
      unsubscribe = undefined;
      await a.createJob('chat-review', 'user-a');
      const review = buildPendingAction(
        buildToolApprovalPayload([{ name: 'read_test', arguments: {}, tool_call_id: 'call-test' }]),
        {
          streamId: 'chat-review',
          conversationId: 'chat-review',
          runId: 'run-test',
          responseMessageId: 'response-test',
        },
      );
      expect(await a.approvals.pause('chat-review', review, { persistencePending: true })).toBe(
        true,
      );
      expect((await a.getReleaseDrainSnapshot()).paused).toBe(1);
      expect((await b.getReleaseDrainSnapshot()).paused).toBe(0);
      await a.approvals.finishPausePersistence('chat-review', review.actionId);
      await b.getJob('chat-review');
      expect(await b.approvals.resolve('chat-review', review.actionId)).toBe(true);
      expect((await a.getReleaseDrainSnapshot()).paused).toBe(0);
      expect((await b.getReleaseDrainSnapshot()).jobs).toBe(1);
      const disconnected = new Promise<void>((resolve) => subB.once('end', resolve));
      subB.disconnect();
      await disconnected;
      expect(b.isReleaseReady).toBe(false);
    } finally {
      unsubscribe?.();
      await a.destroy();
      await b.destroy();
      publisher.disconnect();
      subA.disconnect();
      subB.disconnect();
    }
  });
});
