import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

const action = (streamId: string) =>
  buildPendingAction(
    buildToolApprovalPayload([{ name: 'test_read', arguments: {}, tool_call_id: 'call-test' }]),
    { streamId, conversationId: streamId, runId: 'run-test', responseMessageId: 'message-test' },
  );

describe('generation release drain accounting', () => {
  let store: InMemoryJobStore;
  let a: GenerationJobManagerClass;
  let b: GenerationJobManagerClass;
  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const create = () => {
      const manager = new GenerationJobManagerClass();
      manager.configure({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        isRedis: true,
      });
      return manager;
    };
    a = create();
    b = create();
  });
  afterEach(async () => {
    await a.destroy();
    await b.destroy();
  });

  it('counts local running work and retains paused ownership after its active metric reaches zero', async () => {
    await a.createJob('a', 'user');
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 1, paused: 0 });
    await a.approvals.pause('a', action('a'), { persistencePending: true });
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 1, pending: 1 });
    const paused = await a.approvals.peek('a');
    if (!paused) throw new Error('Missing review action');
    await a.approvals.finishPausePersistence('a', paused.actionId);
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 1, pending: 0 });
    await b.approvals.resolve('a', paused.actionId);
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 0 });
    expect(await b.getReleaseDrainSnapshot()).toMatchObject({ jobs: 1, paused: 0 });
  });

  it('does not count another release work merely because a remote runtime facade exists', async () => {
    await b.createJob('b', 'user');
    await b.approvals.pause('b', action('b'));
    expect(await a.getJob('b')).toBeDefined();
    expect(await a.getReleaseDrainSnapshot()).toEqual({ jobs: 0, paused: 0, pending: 0 });
    expect(await b.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 1 });
  });

  it('retains a failed terminal persistence barrier after local execution has finished', async () => {
    const job = await a.createJob('pending-final', 'user');
    const claim = await a.claimTerminalJob('pending-final', 'complete', undefined, job.createdAt, {
      persistencePending: true,
    });
    if (!claim) throw new Error('Missing terminal claim');
    await a.finishTerminalJob(claim);
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 0, pending: 1 });
    await store.updateJob('pending-final', { terminalPersistencePending: false }, job.createdAt);
    expect(await a.getReleaseDrainSnapshot()).toMatchObject({ jobs: 0, paused: 0, pending: 0 });
  });

  it('does not treat a transport without proven Redis connections as release-ready', () => {
    expect(a.isRedis).toBe(true);
    expect(a.isReleaseReady).toBe(false);
  });
});
