import { createHash, randomUUID } from 'node:crypto';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import type { BrainCandidate } from './session';
import type { BrainReviewCheckpoint } from './review';
import type {
  BrainHistoryJob,
  BrainHistoryMessage,
  BrainHistoryPending,
  BrainHistoryStore,
} from './historyStore';

import type { BrainFailureReporter, BrainFailureStage } from './diagnostics';
import {
  BrainOperationError,
  classifyBrainFailure,
  createBrainFailureReporter,
} from './diagnostics';

export class BrainHistoryError extends BrainOperationError {}

export interface BrainHistoryAvailability {
  available: boolean;
  reason?: string;
  modelLabel?: string;
  analysisFingerprint?: string;
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
    review?: BrainReviewCheckpoint;
    rebuildId?: string;
    onReview?: (review: BrainReviewCheckpoint) => Promise<void>;
  }): Promise<void>;
  ingest(input: {
    req: ServerRequest;
    source: BrainHistoryMessage;
    text: string;
    facts: BrainCandidate[];
    canContinue: () => Promise<boolean>;
    rebuildId?: string;
  }): Promise<number>;
  complete?(req: ServerRequest, rebuildId: string): Promise<void>;
}

export interface BrainHistoryService {
  status(req: ServerRequest): Promise<BrainHistoryStatus>;
  start(req: ServerRequest, options?: { rebuildId: string }): Promise<BrainHistoryStatus>;
  pause(req: ServerRequest, rebuildId?: string): Promise<BrainHistoryStatus>;
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
    available: availability.available,
    reason: availability.reason,
    schemaVersion: job?.schemaVersion,
    unit: job?.schemaVersion === 2 ? 'chats' : 'messages',
    rebuildId: job?.rebuildId,
    processedSections: job?.processedSections,
    ...(job?.error
      ? { error: job.error, errorCode: job.errorCode, incidentId: job.incidentId }
      : {}),
    modelLabel: availability.modelLabel ?? job?.modelLabel,
  };
}

/** A lease serializes work across API replicas. Checkpoints never recreate a deleted account/job. */
export function createBrainHistoryService({
  store,
  processor,
  now = () => new Date(),
  reportFailure = createBrainFailureReporter(),
}: {
  store: BrainHistoryStore;
  processor: BrainHistoryProcessor;
  now?: () => Date;
  reportFailure?: BrainFailureReporter;
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
    let stage: BrainFailureStage = 'source';
    let currentSource: BrainHistoryMessage | null = null;
    let stepStarted = now().getTime();
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
        .catch((error) => {
          active = false;
          void reportFailure({
            failure: classifyBrainFailure(error, 'heartbeat'),
            userId: ownerId,
            operation: 'history',
            stage: 'heartbeat',
            modelLabel: job.modelLabel,
            processed: job.processed,
          }).catch(() => undefined);
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
        if (job.schemaVersion === 2 && job.analysisFingerprint !== availability.analysisFingerprint)
          throw new BrainHistoryError(
            'Die Modell- oder Kontextvorgabe wurde geändert. Bitte den Neuaufbau mit der aktuellen Vorgabe neu starten.',
          );
        if (availability.modelLabel !== job.modelLabel)
          await update({ modelLabel: availability.modelLabel });
        stage = 'source';
        stepStarted = now().getTime();
        const pending = job.pending;
        const loadSource = (conversationId: string, messageId: string) =>
          job.schemaVersion === 2
            ? store.conversation!(ownerId, conversationId, job.cutoff)
            : store.source(ownerId, messageId, conversationId);
        let source: BrainHistoryMessage | null;
        if (pending)
          source = await loadSource(pending.message.conversationId, pending.message.messageId);
        else if (job.schemaVersion === 2)
          source = await store.nextConversation!(ownerId, job.cursor, job.cutoff);
        else source = await store.next(ownerId, job.cursor, job.cutoff);
        currentSource = source;
        if (!source && !pending) {
          if (job.rebuildId) await processor.complete?.(req, job.rebuildId);
          await update({ status: 'completed', total: job.processed, pending: undefined });
          return;
        }
        if (!source || (pending && brainHistorySourceHash(source.text) !== pending.sourceHash)) {
          if (source && job.schemaVersion === 2) {
            await update({ pending: undefined });
            continue;
          }
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
          if (!(await leaseIsCurrent())) return false;
          const currentAvailability = await processor.availability(req);
          if (
            !currentAvailability.available ||
            (job.schemaVersion === 2 &&
              currentAvailability.analysisFingerprint !== job.analysisFingerprint)
          )
            return false;
          if (job.schemaVersion === 2 && (await store.read(ownerId))?.pauseRequested) return false;
          const original = await loadSource(source.conversationId, source.messageId);
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
          stage = 'chunk';
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
          stage = 'extract';
          await processor.extract({
            req,
            source,
            text,
            canContinue,
            rebuildId: job.rebuildId,
            review: step.review,
            onReview: async (review) => {
              const reviewedSection =
                review.phase === 'extract' && review.position > (step.review?.position ?? 0);
              step = { ...step, review };
              await update({
                pending: step,
                processedSections: (job.processedSections ?? 0) + (reviewedSection ? 1 : 0),
              });
            },
            onFacts: async (facts) => {
              step = { ...step, facts };
              await update({ pending: step });
            },
            onBilling: async (billing) => {
              stage = 'billing';
              step = { ...step, billing };
              await update({ pending: step });
              if (billing === 'complete') stage = 'extract';
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
        stage = 'ingest';
        const saved = await processor.ingest({
          req,
          source,
          text,
          facts: step.facts ?? [],
          canContinue,
          rebuildId: job.rebuildId,
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
      if (
        active &&
        job.schemaVersion === 2 &&
        (await store.read(ownerId).catch(() => null))?.pauseRequested
      ) {
        const paused = await store
          .update(ownerId, token, {
            status: 'paused',
            error: undefined,
            errorCode: undefined,
            incidentId: undefined,
          })
          .catch(() => false);
        if (paused) return;
      }
      if (active) {
        const failure = classifyBrainFailure(error, stage);
        await reportFailure({
          failure,
          userId: ownerId,
          operation: 'history',
          stage,
          conversationId: currentSource?.conversationId,
          messageId: currentSource?.messageId,
          modelLabel: job.modelLabel,
          processed: job.processed,
          durationMs: now().getTime() - stepStarted,
        }).catch(() => undefined);
        await store
          .update(ownerId, token, {
            status: 'failed',
            error: `${failure.message} Referenz: ${failure.incidentId}`,
            errorCode: failure.code,
            incidentId: failure.incidentId,
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
    async start(req: ServerRequest, options?: { rebuildId: string }): Promise<BrainHistoryStatus> {
      const ownerId = String(req.user!.id);
      const availability = await processor.availability(req);
      if (!availability.available) return publicStatus(await read(ownerId), availability);
      let job = await read(ownerId);
      if (options && (job?.schemaVersion !== 2 || job.rebuildId !== options.rebuildId)) {
        if (
          !store.resetConversationJob ||
          !store.conversation ||
          !store.nextConversation ||
          !store.countConversations
        )
          throw new BrainHistoryError(
            'Der Gesprächsimport ist in diesem Serverstand noch nicht verfügbar.',
          );
        await store.resetConversationJob({
          _id: ownerId,
          ownerId,
          status: 'idle',
          total: 0,
          processed: 0,
          saved: 0,
          skipped: 0,
          revision: (job?.revision ?? 0) + 1,
          cutoff: now(),
          schemaVersion: 2,
          rebuildId: options.rebuildId,
          analysisFingerprint: availability.analysisFingerprint,
          processedSections: 0,
        });
        job = await read(ownerId);
      } else if (!options && store.resetConversationJob && job?.schemaVersion !== 2) {
        throw new BrainHistoryError(
          'Bitte «Brain neu aufbauen» verwenden. Alte Einzelnachrichten-Importe werden nicht fortgesetzt.',
        );
      }
      if (job?.status === 'running') return publicStatus(job, availability);
      if (job?.schemaVersion === 2 && job.status === 'completed')
        return publicStatus(job, availability);
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
        const total =
          job.processed +
          (job.schemaVersion === 2
            ? await store.countConversations!(ownerId, job.cursor, cutoff)
            : await store.count(ownerId, job.cursor, cutoff));
        let error: string | undefined;
        if (job.pending && job.pending.facts === undefined) error = interruptedMessage;
        else if (job.pending?.billing === 'started') error = billingUncertainMessage;
        const fields = {
          cutoff,
          total,
          error,
          errorCode: undefined,
          incidentId: undefined,
          modelLabel: availability.modelLabel,
        };
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
    async pause(req: ServerRequest, rebuildId?: string): Promise<BrainHistoryStatus> {
      await store.pause(String(req.user!.id), rebuildId);
      return this.status(req);
    },
    /** Tests and controlled shutdowns may await the owned worker without exposing it over HTTP. */
    async settle(ownerId: string): Promise<void> {
      await workers.get(ownerId);
    },
  };
}
