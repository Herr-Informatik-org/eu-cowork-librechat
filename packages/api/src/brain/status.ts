import { createHash, randomUUID } from 'node:crypto';
import type { Collection, Document } from 'mongodb';
import type { BrainLearningStatus } from 'librechat-data-provider';
import type { BrainSession } from './session';
import type { BrainLearningOutcome } from './learning';
import type { BrainFailureReporter } from './diagnostics';
import { classifyBrainFailure } from './diagnostics';

export interface BrainLearningRun {
  id: string;
  ownerId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceCreatedAt: string;
  messageId: string;
}
type Result = Pick<BrainLearningStatus, 'status' | 'saved' | 'errorCode' | 'incidentId'>;
export interface BrainLearningStore {
  start(run: BrainLearningRun): Promise<void>;
  heartbeat(run: BrainLearningRun): Promise<void>;
  finish(run: BrainLearningRun, result: Result): Promise<void>;
  discard(run: BrainLearningRun): Promise<void>;
  latest(ownerId: string, conversationId?: string): Promise<BrainLearningStatus>;
}

/** Metadata only: no source text, model payloads or candidates are retained here. */
export function createMongoBrainLearningStore(
  collection: () => Collection<Document>,
  now: () => Date = () => new Date(),
  tombstones?: () => Collection<Document>,
): BrainLearningStore {
  let indexes: Promise<unknown> | undefined;
  const where = (run: BrainLearningRun) => ({ id: run.id, ownerId: run.ownerId });
  const deleted = async (
    run: Pick<
      BrainLearningRun,
      'ownerId' | 'conversationId' | 'sourceMessageId' | 'sourceCreatedAt'
    >,
  ) => {
    const key = (kind: string, value: string) =>
      `${kind}:${createHash('sha256').update(value).digest('hex')}`;
    return tombstones
      ? !!(await tombstones().findOne({
          ownerId: run.ownerId,
          $or: [
            { key: 'user', deletedAt: { $gte: run.sourceCreatedAt } },
            {
              key: {
                $in: [
                  key('conversation', run.conversationId),
                  key(
                    'source',
                    `chat:${encodeURIComponent(run.conversationId)}:${encodeURIComponent(run.sourceMessageId)}`,
                  ),
                ],
              },
            },
          ],
        }))
      : false;
  };
  return {
    async start(run) {
      indexes ??= Promise.all([
        collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        collection().createIndex({ ownerId: 1, conversationId: 1, startedAt: -1 }),
        collection().createIndex({ ownerId: 1, startedAt: -1 }),
      ]).catch((error) => {
        indexes = undefined;
        throw error;
      });
      await indexes;
      const at = now();
      await collection().insertOne({
        ...run,
        status: 'running',
        saved: 0,
        startedAt: at,
        updatedAt: at,
        expiresAt: new Date(at.getTime() + 30 * 86400_000),
      });
      // Sidecar tombstones precede cleanup; this closes insertion racing with that cleanup.
      if (await deleted(run)) await collection().deleteOne(where(run));
    },
    async heartbeat(run) {
      await collection().updateOne(
        { ...where(run), status: 'running' },
        { $set: { updatedAt: now() } },
      );
    },
    async finish(run, result) {
      // Never upsert: source/account deletion must not recreate a diagnostic record.
      await collection().updateOne(
        { ...where(run), status: 'running' },
        { $set: { ...result, updatedAt: now() } },
      );
    },
    async discard(run) {
      await collection().deleteOne(where(run));
    },
    async latest(ownerId, conversationId) {
      const doc = await collection().findOne(
        { ownerId, ...(conversationId ? { conversationId } : {}), expiresAt: { $gt: now() } },
        { sort: { startedAt: -1 } },
      );
      if (
        !doc ||
        (await deleted({
          ownerId,
          conversationId: doc.conversationId,
          sourceMessageId: doc.sourceMessageId,
          sourceCreatedAt: doc.sourceCreatedAt,
        }))
      )
        return { status: 'idle', saved: 0 };
      const stale =
        doc.status === 'running' && now().getTime() - new Date(doc.updatedAt).getTime() > 120_000;
      return {
        status: stale ? 'interrupted' : doc.status,
        saved: doc.saved,
        startedAt: new Date(doc.startedAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
        conversationId: doc.conversationId,
        messageId: doc.messageId,
        ...(doc.errorCode ? { errorCode: doc.errorCode } : {}),
        ...(doc.incidentId ? { incidentId: doc.incidentId } : {}),
      };
    },
  };
}

/** Status storage cannot stop learning; failures never become a successful completion. */
export async function trackBrainLearning({
  session,
  action,
  store,
  reportFailure,
}: {
  session: BrainSession;
  action: () => Promise<BrainLearningOutcome>;
  store: BrainLearningStore;
  reportFailure: BrainFailureReporter;
}): Promise<void> {
  const run = {
    id: randomUUID(),
    ownerId: session.options.userId,
    conversationId: session.options.conversationId,
    messageId: session.options.messageId,
    sourceMessageId: session.options.source.id,
    sourceCreatedAt: session.options.source.createdAt,
  };
  const started = Date.now();
  if (session.options.signal?.aborted) return;
  const stored = await store.start(run).then(
    () => true,
    () => false,
  );
  // Recheck after index/insert awaits: deletion can precede this late insertion.
  if (session.options.canPersist && !(await session.options.canPersist().catch(() => false))) {
    if (stored) await store.discard(run).catch(() => undefined);
    return;
  }
  const finish = (result: Result) =>
    stored ? store.finish(run, result).catch(() => undefined) : Promise.resolve();
  const interrupted = () => {
    void finish({ status: 'interrupted', saved: 0 });
  };
  session.options.signal?.addEventListener('abort', interrupted, { once: true });
  const timer = setInterval(() => {
    if (stored) void store.heartbeat(run).catch(() => undefined);
  }, 30_000);
  timer.unref?.();
  try {
    const outcome = await action();
    await finish(session.options.signal?.aborted ? { status: 'interrupted', saved: 0 } : outcome);
  } catch (error) {
    if (session.options.signal?.aborted) {
      await finish({ status: 'interrupted', saved: 0 });
    } else {
      const failure = classifyBrainFailure(error, 'extract');
      await finish({
        status: 'failed',
        saved: 0,
        errorCode: failure.code,
        incidentId: failure.incidentId,
      });
      await reportFailure({
        failure,
        userId: run.ownerId,
        conversationId: run.conversationId,
        messageId: run.sourceMessageId,
        operation: 'learning',
        stage: 'extract',
        durationMs: Date.now() - started,
      }).catch(() => undefined);
    }
  } finally {
    clearInterval(timer);
    session.options.signal?.removeEventListener('abort', interrupted);
  }
}
