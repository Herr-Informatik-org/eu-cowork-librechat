import { createHash, randomUUID } from 'node:crypto';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import type { BrainCandidate } from './session';
import type {
  BrainHistoryJob,
  BrainHistoryMessage,
  BrainHistoryPending,
  BrainHistoryStore,
} from './historyStore';

export class BrainHistoryError extends Error {}

export interface BrainHistoryAvailability {
  available: boolean;
  reason?: string;
  modelLabel?: string;
}

export interface BrainHistoryProcessor {
  availability(req: ServerRequest): Promise<BrainHistoryAvailability>;
  chunk(req: ServerRequest, source: BrainHistoryMessage, offset: number): Promise<number>;
  extract(input: {
    req: ServerRequest;
    source: BrainHistoryMessage;
    text: string;
    canContinue: () => Promise<boolean>;
    onFacts: (facts: BrainCandidate[]) => Promise<void>;
    onBilling: (state: 'started' | 'complete') => Promise<void>;
  }): Promise<void>;
  ingest(input: {
    req: ServerRequest;
    source: BrainHistoryMessage;
    text: string;
    facts: BrainCandidate[];
    canContinue: () => Promise<boolean>;
  }): Promise<number>;
}

export interface BrainHistoryService {
  status(req: ServerRequest): Promise<BrainHistoryStatus>;
  start(req: ServerRequest): Promise<BrainHistoryStatus>;
  pause(req: ServerRequest): Promise<BrainHistoryStatus>;
  settle(ownerId: string): Promise<void>;
}

const interruptedMessage =
  'Die Verarbeitung wurde unterbrochen. Bereits ausgewertete Beiträge werden beim Fortsetzen weiterverwendet. Für eine noch offene Modellanfrage oder Kostenbuchung ist der Abschluss ungewiss; ein erneuter Modellversuch kann Kosten verursachen.';
const billingUncertainMessage =
  'Eine frühere Kostenbuchung konnte nicht abschliessend bestätigt werden. Sie wird beim Fortsetzen nicht automatisch wiederholt. Die Administration sollte diese Buchung prüfen; der Import verwendet das bereits ausgewertete Ergebnis.';
const defaultFailure =
  'Die Verarbeitung wurde angehalten. Bitte prüfe die Verbindung und das verfügbare Guthaben und versuche es erneut. Bereits abgeschlossene Beiträge bleiben erhalten.';
const leaseMs = 90_000;

export const brainHistorySourceHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function publicStatus(
  job: BrainHistoryJob | null,
  availability: BrainHistoryAvailability,
): BrainHistoryStatus {
  return {
    status: job?.status ?? 'idle',
    total: job?.total ?? 0,
    processed: job?.processed ?? 0,
    saved: job?.saved ?? 0,
    skipped: job?.skipped ?? 0,
    ...availability,
    ...(job?.error ? { error: job.error } : {}),
    modelLabel: availability.modelLabel ?? job?.modelLabel,
  };
}

/** A lease serializes work across API replicas. Checkpoints never recreate a deleted account/job. */
export function createBrainHistoryService({
  store,
  processor,
  now = () => new Date(),
}: {
  store: BrainHistoryStore;
  processor: BrainHistoryProcessor;
  now?: () => Date;
}): BrainHistoryService {
  const workers = new Map<string, Promise<void>>();

  const read = async (ownerId: string) => {
    await store.expire(ownerId, now(), interruptedMessage);
    return store.read(ownerId);
  };

  async function execute(
    req: ServerRequest,
    claimed: BrainHistoryJob,
    token: string,
  ): Promise<void> {
    const ownerId = String(req.user!.id);
    let job = claimed;
    let active = true;
    const update = async (fields: Partial<BrainHistoryJob>) => {
      if (!active || !(await store.update(ownerId, token, fields))) {
        active = false;
        throw new BrainHistoryError('Die Verarbeitung wurde beendet.');
      }
      job = { ...job, ...fields };
    };
    const leaseIsCurrent = async () => {
      const current = await store.read(ownerId);
      return (
        active &&
        current?.status === 'running' &&
        current.leaseToken === token &&
        (current.leaseUntil?.getTime() ?? 0) > now().getTime()
      );
    };
    const heartbeat = setInterval(() => {
      void store
        .update(ownerId, token, { leaseUntil: new Date(now().getTime() + leaseMs) })
        .then((ok) => {
          if (!ok) active = false;
        })
        .catch(() => {
          active = false;
        });
    }, leaseMs / 3);
    heartbeat.unref?.();
    try {
      while (await leaseIsCurrent()) {
        const current = await store.read(ownerId);
        if (current?.pauseRequested) {
          await update({ status: 'paused' });
          return;
        }
        const availability = await processor.availability(req);
        if (!availability.available) {
          await update({ status: 'paused', error: availability.reason });
          return;
        }
        if (availability.modelLabel !== job.modelLabel)
          await update({ modelLabel: availability.modelLabel });
        const pending = job.pending;
        const source = pending
          ? await store.source(ownerId, pending.message.messageId, pending.message.conversationId)
          : await store.next(ownerId, job.cursor, job.cutoff);
        if (!source && !pending) {
          await update({ status: 'completed', total: job.processed, pending: undefined });
          return;
        }
        if (!source || (pending && brainHistorySourceHash(source.text) !== pending.sourceHash)) {
          // A deleted or edited original cannot support stored extraction results.
          await update({
            cursor: pending!.message,
            pending: undefined,
            processed: job.processed + 1,
            skipped: job.skipped + 1,
          });
          continue;
        }
        const canContinue = async () => {
          if (!(await leaseIsCurrent()) || !(await processor.availability(req)).available)
            return false;
          const original = await store.source(ownerId, source.messageId, source.conversationId);
          return (
            original != null &&
            brainHistorySourceHash(original.text) === brainHistorySourceHash(source.text)
          );
        };
        let step: BrainHistoryPending = pending ?? {
          message: {
            messageId: source.messageId,
            conversationId: source.conversationId,
            createdAt: source.createdAt,
          },
          sourceHash: brainHistorySourceHash(source.text),
          offset: 0,
          end: 0,
          saved: 0,
        };
        if (!step.end || step.facts === undefined) {
          const end = await processor.chunk(req, source, step.offset);
          step = { ...step, end: step.end ? Math.min(step.end, end) : end };
        }
        await update({ pending: step });
        const text = source.text.slice(step.offset, step.end);
        if (step.facts === undefined) {
          if (!(await canContinue()))
            throw new BrainHistoryError(
              'Die Originalquelle oder die Berechtigung ist nicht mehr verfügbar.',
            );
          await processor.extract({
            req,
            source,
            text,
            canContinue,
            onFacts: async (facts) => {
              step = { ...step, facts };
              await update({ pending: step });
            },
            onBilling: async (billing) => {
              step = { ...step, billing };
              await update({ pending: step });
            },
          });
          if (step.facts === undefined) {
            step = { ...step, facts: [] };
            await update({ pending: step });
          }
        }
        if (!(await canContinue()))
          throw new BrainHistoryError(
            'Die Originalquelle oder die Berechtigung ist nicht mehr verfügbar.',
          );
        const saved = await processor.ingest({
          req,
          source,
          text,
          facts: step.facts ?? [],
          canContinue,
        });
        const sourceDone = step.end >= source.text.length;
        await update({
          saved: job.saved + saved,
          ...(sourceDone
            ? {
                cursor: step.message,
                pending: undefined,
                processed: job.processed + 1,
                skipped: job.skipped + (step.saved + saved === 0 ? 1 : 0),
              }
            : {
                pending: {
                  ...step,
                  offset: step.end,
                  end: 0,
                  saved: step.saved + saved,
                  facts: undefined,
                  billing: undefined,
                },
              }),
        });
      }
    } catch (error) {
      if (active) {
        await store
          .update(ownerId, token, {
            status: 'failed',
            error: error instanceof BrainHistoryError ? error.message : defaultFailure,
          })
          .catch(() => undefined);
      }
    } finally {
      active = false;
      clearInterval(heartbeat);
    }
  }

  return {
    async status(req: ServerRequest): Promise<BrainHistoryStatus> {
      const ownerId = String(req.user!.id);
      const [job, availability] = await Promise.all([read(ownerId), processor.availability(req)]);
      return publicStatus(job, availability);
    },
    async start(req: ServerRequest): Promise<BrainHistoryStatus> {
      const ownerId = String(req.user!.id);
      const availability = await processor.availability(req);
      if (!availability.available) return publicStatus(await read(ownerId), availability);
      let job = await read(ownerId);
      if (job?.status === 'running') return publicStatus(job, availability);
      if (!job) {
        await store.create({
          _id: ownerId,
          ownerId,
          status: 'idle',
          total: 0,
          processed: 0,
          saved: 0,
          skipped: 0,
          revision: 0,
          cutoff: now(),
        });
        job = await read(ownerId);
      }
      if (!job) throw new BrainHistoryError('Die Verarbeitung konnte nicht gestartet werden.');
      const token = randomUUID();
      const claimed = await store.claim(
        ownerId,
        job.revision,
        token,
        new Date(now().getTime() + leaseMs),
      );
      if (!claimed) return publicStatus(await read(ownerId), availability);
      try {
        const cutoff = job.status === 'completed' || job.status === 'idle' ? now() : job.cutoff;
        const total = job.processed + (await store.count(ownerId, job.cursor, cutoff));
        const error =
          job.pending && job.pending.facts === undefined
            ? interruptedMessage
            : job.pending?.billing === 'started'
              ? billingUncertainMessage
              : undefined;
        const fields = { cutoff, total, error, modelLabel: availability.modelLabel };
        if (!(await store.update(ownerId, token, fields)))
          throw new BrainHistoryError('Die Verarbeitung wurde beendet.');
        const running = { ...claimed, ...fields };
        const worker = Promise.resolve().then(() => execute(req, running, token));
        workers.set(ownerId, worker);
        void worker.finally(() => {
          if (workers.get(ownerId) === worker) workers.delete(ownerId);
        });
        return publicStatus(running, availability);
      } catch (error) {
        await store.update(ownerId, token, { status: 'failed', error: defaultFailure });
        throw error;
      }
    },
    async pause(req: ServerRequest): Promise<BrainHistoryStatus> {
      await store.pause(String(req.user!.id));
      return this.status(req);
    },
    /** Tests and controlled shutdowns may await the owned worker without exposing it over HTTP. */
    async settle(ownerId: string): Promise<void> {
      await workers.get(ownerId);
    },
  };
}
