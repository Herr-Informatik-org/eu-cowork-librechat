import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  MailAnalysis,
  MailAssistantEngine,
  MailJob,
  MailHistoryCheckpoint,
  MailMessage,
  MailPriority,
  MailResult,
  MailResultContent,
  MailResultQuery,
  MailResultPage,
  MailFolder,
  MailRuntimeAdapter,
  MailStore,
  StoredMailResult,
  StoredMailMoveJob,
  MailMoveJob,
  MailMoveRequest,
  MailRuleInput,
} from './types';
import { MAIL_CATEGORIES, MAIL_CONSENT_VERSION } from './types';
import {
  defaultMailSettings,
  insideMailWindow,
  mailSettingsSchema,
  nextMailRun,
  mailHistoryStart,
} from './schedule';
import { MailGraphError } from './graph';
import { activeMoveJob, publicMoveJob, summarizeMove } from './moves';

export class MailAssistantError extends Error {}
class ManualMovePending extends Error {}
class ManualLeaseBusy extends MailAssistantError {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resultRevision = (result: StoredMailResult) =>
  hash([result.messageId, result.conversationId, result.sourceHash]);
const sourceHash = (mail: MailMessage) =>
  hash([mail.id, mail.subject, mail.sender, mail.receivedAt, mail.body]);
const insideHistory = (mail: MailMessage, history: MailHistoryCheckpoint) =>
  !mail.isDraft &&
  Date.parse(mail.receivedAt) < Date.parse(history.until) &&
  (!history.from || Date.parse(mail.receivedAt) >= Date.parse(history.from));
export const mailAnalysisSchema: z.ZodType<MailAnalysis> = z
  .object({
    priority: z.enum(['important', 'normal', 'low']),
    action: z.enum(['reply', 'review', 'information']),
    summary: z.string().min(1).max(1600),
    reason: z.string().min(1).max(800),
    questions: z.array(z.string().min(1).max(500)).max(10),
    draft: z.string().max(12000),
    memory: z
      .object({
        status: z.enum(['available', 'empty', 'disabled', 'unavailable']),
        count: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();

function publicResult(value: StoredMailResult): MailResult {
  const {
    messageId: _message,
    conversationId: _conversation,
    sourceHash: _source,
    categoryApplied: _category,
    draftId: _draft,
    operationPending: _pending,
    moveDestination: _destination,
    editPending: _edit,
    ...result
  } = value;
  return {
    ...result,
    revision: resultRevision(value),
    ...(value.operationPending && { draftStatus: 'uncertain' as const }),
  };
}

/** The model proposes data only. This deterministic engine owns every allowed mailbox mutation. */
export function createMailAssistantEngine({
  store,
  adapter,
  now = () => new Date(),
}: {
  store: MailStore;
  adapter: MailRuntimeAdapter;
  now?: () => Date;
}): MailAssistantEngine {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let lastPruned = 0;
  const moveWakeups = new Map<string, ReturnType<typeof setTimeout>>();
  const wakeMoves = (owner: string) => {
    if (!timer || moveWakeups.has(owner)) return;
    const timeout = setTimeout(() => {
      moveWakeups.delete(owner);
      void processMove(owner).catch(() => {});
    }, 1000);
    timeout.unref();
    moveWakeups.set(owner, timeout);
  };
  async function available(owner: string) {
    await adapter.authorize(owner);
    const state = await adapter.availability(owner);
    if (!state.available)
      throw new MailAssistantError(
        state.reason ?? 'Der persönliche Mail-Assistent ist nicht freigegeben.',
      );
    return state;
  }
  async function active(owner: string, job: MailJob, token: string, scheduled: boolean) {
    await available(owner);
    const latest = await store.read(owner);
    if (
      !latest?.settings.enabled ||
      latest.settings.consentVersion !== MAIL_CONSENT_VERSION ||
      latest.revision !== job.revision ||
      latest.leaseToken !== token ||
      !latest.leaseUntil ||
      latest.leaseUntil.getTime() <= now().getTime() ||
      (scheduled &&
        (latest.settings.mode !== 'scheduled' || !insideMailWindow(latest.settings, now())))
    ) {
      throw new MailAssistantError(
        'Die Verarbeitung wurde pausiert oder das Arbeitszeitfenster ist beendet.',
      );
    }
    if (!(await adapter.connection(owner)).connected)
      throw new MailAssistantError('Bitte verbinde dein persönliches Microsoft-Konto.');
    if (!(await store.update(owner, token, { leaseUntil: new Date(now().getTime() + 120_000) })))
      throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
  }
  async function process(
    owner: string,
    job: MailJob,
    token: string,
    id: string,
    guard: () => Promise<void>,
    history?: MailHistoryCheckpoint,
  ) {
    const graph = await adapter.graph(owner, guard);
    let mail: MailMessage;
    try {
      mail = await graph.message(id);
    } catch (error) {
      if (error instanceof MailGraphError && error.status === 404) return;
      throw error;
    }
    if (
      history
        ? !insideHistory(mail, history)
        : mail.isDraft || Date.parse(mail.receivedAt) < Date.parse(job.enabledAt!)
    )
      return;
    const resultId = hash([owner, mail.conversationId]);
    const previous = await store.result(owner, resultId);
    if (previous?.moveStatus && previous.messageId === mail.id) return;
    const barrier = await store.draftState(owner, resultId);
    const uncertain =
      barrier?.state === 'pending' ||
      previous?.operationPending ||
      previous?.draftStatus === 'uncertain';
    if (uncertain && previous?.messageId === mail.id) return;
    if (
      previous?.messageId === mail.id &&
      previous.sourceHash === sourceHash(mail) &&
      previous.categoryApplied
    ) {
      const correction = (Object.keys(MAIL_CATEGORIES) as MailPriority[]).find((priority) =>
        mail.categories.includes(MAIL_CATEGORIES[priority]),
      );
      if (correction && correction !== previous.priority) {
        await guard();
        await adapter.audit(owner, 'outlook_category_correction', resultId);
        await store.putResult(owner, token, {
          ...previous,
          priority: correction,
          manualPriority: true,
        });
      }
      return;
    }
    if (previous && Date.parse(previous.receivedAt) > Date.parse(mail.receivedAt)) return;
    const thread = await graph.thread(mail.conversationId);
    const context = thread.messages
      .filter((item) => !item.isDraft)
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    if (!context.some((item) => item.id === mail.id)) context.push(mail);
    const tooLong =
      context.some((item) => item.bodyTruncated) || JSON.stringify(context).length > 55000;
    let analysis = tooLong
      ? {
          priority: 'normal' as const,
          action: 'review' as const,
          summary: 'Diese Unterhaltung ist zu umfangreich für die automatische Prüfung.',
          reason: 'Bitte die vollständigen Nachrichten in Outlook prüfen.',
          questions: ['Die Priorität und der Antwortbedarf müssen manuell geprüft werden.'],
          draft: '',
        }
      : mailAnalysisSchema.parse(await adapter.analyze(owner, context.slice(-20), guard));
    await guard();
    const alreadyAnswered = thread.messages.some(
      (item) =>
        item.sentByUser &&
        Date.parse(item.sentAt ?? item.receivedAt) >= Date.parse(mail.receivedAt),
    );
    if (alreadyAnswered) analysis = { ...analysis, action: 'information', draft: '' };
    if (!thread.complete)
      analysis = {
        ...analysis,
        action: 'review',
        draft: '',
        questions: [
          ...analysis.questions.slice(0, 9),
          'Der lange Gesprächsverlauf wurde nicht vollständig geprüft. Bitte in Outlook kontrollieren.',
        ],
      };
    const existing = thread.messages.find((item) => item.isDraft);
    const latestMail = await graph.message(mail.id);
    const currentCategories = latestMail.categories;
    const existingPriority = (Object.keys(MAIL_CATEGORIES) as MailPriority[]).find((priority) =>
      currentCategories.includes(MAIL_CATEGORIES[priority]),
    );
    const manuallyChanged =
      previous?.manualPriority ||
      (existingPriority && (!previous || existingPriority !== previous.priority));
    const priority = manuallyChanged ? (existingPriority ?? previous!.priority) : analysis.priority;
    let draftStatus: StoredMailResult['draftStatus'] = 'none';
    if (existing) draftStatus = previous?.draftId === existing.id ? 'stale' : 'existing';
    if (uncertain) draftStatus = 'uncertain';
    const result: StoredMailResult = {
      id: resultId,
      messageId: mail.id,
      conversationId: mail.conversationId,
      sourceHash: sourceHash(mail),
      subject: mail.subject,
      sender: mail.sender,
      receivedAt: mail.receivedAt,
      messageUrl: mail.messageUrl,
      priority,
      summary: analysis.summary,
      reason: analysis.reason,
      action: analysis.action,
      questions: analysis.questions,
      ...(analysis.memory ? { memory: analysis.memory } : {}),
      draftStatus,
      ...(uncertain && { operationPending: true }),
      ...(existing && { draftId: existing.id, draftUrl: existing.messageUrl }),
      ...(manuallyChanged && { manualPriority: true }),
      categoryApplied: false,
    };
    await guard();
    await store.putResult(owner, token, result);
    const categories = [
      ...currentCategories.filter((value) => !Object.values(MAIL_CATEGORIES).includes(value)),
      MAIL_CATEGORIES[priority],
    ];
    await adapter.audit(owner, 'category_requested', resultId);
    await graph.categorize(mail.id, [...new Set(categories)], latestMail.etag);
    await adapter.audit(owner, 'category_completed', resultId);
    result.categoryApplied = true;
    await guard();
    await store.putResult(owner, token, result);
    if (
      uncertain ||
      analysis.action !== 'reply' ||
      priority === 'low' ||
      existing ||
      !analysis.draft.trim()
    )
      return;
    // Re-read the thread immediately before creation: an employee may have answered or started a draft meanwhile.
    const fresh = await graph.thread(mail.conversationId);
    if (
      !fresh.complete ||
      fresh.messages.some(
        (item) =>
          item.isDraft ||
          (item.sentByUser &&
            Date.parse(item.sentAt ?? item.receivedAt) >= Date.parse(mail.receivedAt)) ||
          (!item.sentByUser &&
            !item.isDraft &&
            Date.parse(item.receivedAt) > Date.parse(mail.receivedAt)),
      )
    ) {
      result.draftStatus = 'existing';
      result.questions = [
        ...result.questions.slice(0, 9),
        'Der Gesprächsverlauf wurde inzwischen verändert. Bitte in Outlook prüfen.',
      ];
      await store.putResult(owner, token, result);
      return;
    }
    await adapter.audit(owner, 'draft_requested', resultId);
    await guard();
    if (!(await store.reserveDraft(owner, token, resultId, sourceHash(mail)))) return;
    // Persist before POST. A crash or ambiguous response can never trigger a blind second creation.
    result.operationPending = true;
    result.draftStatus = 'uncertain';
    await store.putResult(owner, token, result);
    try {
      const created = await graph.createReply(mail.id, analysis.draft);
      await store.finishDraft(owner, resultId, sourceHash(mail), 'completed');
      result.draftId = created.id;
      result.draftUrl = created.url;
      result.draftStatus = 'created';
      if (created.warnings?.length) result.draftWarnings = created.warnings;
      result.operationPending = false;
      await adapter.audit(owner, 'draft_completed', resultId);
      await guard();
      await store.putResult(owner, token, result);
      if (created.stop)
        throw new MailAssistantError(
          'Die Mailprüfung wurde nach einem unvollständigen Entwurf angehalten. Bitte prüfe seine Hinweise in Outlook.',
        );
    } catch (error) {
      if (error instanceof MailGraphError && !error.uncertain) {
        await store.finishDraft(owner, resultId, sourceHash(mail), 'failed');
        result.operationPending = false;
        result.draftStatus = 'error';
        await store.putResult(owner, token, result);
      }
      throw error;
    }
  }
  async function run(owner: string, scheduled = false, resumeRevision?: number) {
    await available(owner);
    const initial = await store.read(owner);
    if (
      !initial?.settings.enabled ||
      !initial.enabledAt ||
      initial.settings.consentVersion !== MAIL_CONSENT_VERSION
    )
      throw new MailAssistantError('Bitte aktiviere zuerst deine persönliche Mailverarbeitung.');
    if (
      resumeRevision !== undefined &&
      (initial.revision !== resumeRevision ||
        initial.continuation?.revision !== resumeRevision ||
        initial.continuation?.mode !== 'manual')
    )
      return;
    if (initial.movePending) {
      wakeMoves(owner);
      return;
    }
    const token = randomUUID();
    const job = await store.claim(owner, token, now(), false, initial.revision);
    if (!job) {
      if (scheduled || resumeRevision !== undefined) return;
      throw new MailAssistantError('Eine Prüfung läuft bereits.');
    }
    if (
      scheduled &&
      (job.settings.mode !== 'scheduled' || !insideMailWindow(job.settings, now()))
    ) {
      await store.release(owner, token, {
        nextRunAt: nextMailRun(job.settings, now()) ?? '',
      });
      return;
    }
    const guard = () => active(owner, job, token, scheduled);
    let errorMessage = '';
    try {
      await guard();
      await adapter.audit(owner, scheduled ? 'scheduled_run_started' : 'manual_run_started');
      const continuation =
        job.continuation?.revision === job.revision
          ? job.continuation
          : {
              mode: scheduled ? ('scheduled' as const) : ('manual' as const),
              revision: job.revision,
              liveComplete: false,
            };
      if (!(await store.update(owner, token, { continuation, nextRunAt: now().toISOString() })))
        throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
      const deadline = now().getTime() + 4 * 60_000;
      let processed = 0;
      const history = job.settings.history?.mode !== 'off' ? job.history : undefined;
      const graph = await adapter.graph(owner, guard);
      const live = async (limit: number) => {
        if (continuation.liveComplete || processed >= limit || now().getTime() >= deadline) return;
        let checkpoint = job.checkpoint ?? { pending: [] };
        if (!checkpoint.pending.length) {
          const page = await graph.page(job.enabledAt!, checkpoint.url);
          if (page.hasMore && (!page.nextUrl || page.nextUrl === checkpoint.url))
            throw new MailAssistantError(
              'Microsoft hat keine neue Posteingangsseite geliefert. Die Prüfung wurde angehalten.',
            );
          checkpoint = {
            ...checkpoint,
            pending: [
              ...new Set(
                page.messages
                  .filter(
                    (item) =>
                      !item.isDraft && Date.parse(item.receivedAt) >= Date.parse(job.enabledAt!),
                  )
                  .map((item) => item.id),
              ),
            ],
            nextUrl: page.nextUrl,
            hasMore: page.hasMore,
          };
          if (!(await store.update(owner, token, { checkpoint })))
            throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
        }
        while (checkpoint.pending.length && processed < limit && now().getTime() < deadline) {
          await guard();
          if ((await store.read(owner))?.movePending) throw new ManualMovePending();
          await process(owner, job, token, checkpoint.pending[0], guard);
          processed++;
          checkpoint.pending.shift();
          if (!checkpoint.pending.length)
            checkpoint = { pending: [], url: checkpoint.nextUrl, hasMore: checkpoint.hasMore };
          if (!(await store.update(owner, token, { checkpoint })))
            throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
        }
        if (!checkpoint.pending.length && !checkpoint.hasMore) {
          continuation.liveComplete = true;
          if (!(await store.update(owner, token, { continuation })))
            throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
        }
        if (!checkpoint.pending.length && checkpoint.nextUrl)
          if (
            !(await store.update(owner, token, {
              checkpoint: { pending: [], url: checkpoint.nextUrl, hasMore: checkpoint.hasMore },
            }))
          )
            throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
      };
      const historical = async (limit: number) => {
        if (!history || history.completed || processed >= limit || now().getTime() >= deadline)
          return;
        const selection = job.settings.history!;
        if (
          history.until !== job.enabledAt ||
          history.from !==
            (selection.mode === 'since'
              ? mailHistoryStart(selection.from!, job.settings.timeZone)
              : undefined)
        )
          throw new MailAssistantError(
            'Der Zeitraum der Bestandsprüfung passt nicht zur gespeicherten Freigabe. Bitte die Einstellungen prüfen.',
          );
        await guard();
        await adapter.audit(owner, 'history_batch_started');
        if (!history.pending.length) {
          const page = await graph.historyPage(history.from, history.until, history.url);
          if (page.hasMore && (!page.nextUrl || page.nextUrl === history.url))
            throw new MailAssistantError(
              'Microsoft hat keine neue Bestandsseite geliefert. Die Prüfung wurde angehalten.',
            );
          history.pending = [
            ...new Set(
              page.messages
                .filter((item) => insideHistory(item, history))
                .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
                .map((item) => item.id),
            ),
          ];
          history.nextUrl = page.nextUrl;
          history.hasMore = page.hasMore;
          if (!history.pending.length) {
            history.url = history.nextUrl;
            history.completed = !history.hasMore;
          }
          if (!(await store.update(owner, token, { history })))
            throw new MailAssistantError('Die Bestandsprüfung wurde angehalten.');
        }
        while (history.pending.length && processed < limit && now().getTime() < deadline) {
          await guard();
          if ((await store.read(owner))?.movePending) throw new ManualMovePending();
          await process(owner, job, token, history.pending[0], guard, history);
          processed++;
          history.processed++;
          history.pending.shift();
          if (!history.pending.length) {
            history.url = history.nextUrl;
            history.completed = !history.hasMore;
          }
          if (!(await store.update(owner, token, { history })))
            throw new MailAssistantError('Die Bestandsprüfung wurde angehalten.');
        }
        await adapter.audit(
          owner,
          history.completed ? 'history_completed' : 'history_batch_completed',
        );
      };
      if (history && !history.completed) {
        const historyFirst = history.nextFirst !== 'live';
        history.nextFirst = historyFirst ? 'live' : 'history';
        if (!(await store.update(owner, token, { history })))
          throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
        // Alternate the first batch durably so slow model responses cannot starve either stream.
        if (historyFirst) {
          await historical(10);
          await live(20);
        } else {
          await live(10);
          await historical(20);
        }
      } else await live(20);
      await adapter.audit(owner, 'run_completed');
    } catch (error) {
      if (error instanceof ManualMovePending) errorMessage = '';
      else if (error instanceof MailGraphError || error instanceof MailAssistantError)
        errorMessage = error.message;
      else
        errorMessage =
          'Die Mailprüfung wurde angehalten. Bitte prüfe Verbindung, Modellfreigabe und Guthaben. Es wird nichts automatisch versendet.';
      // No source data or provider error strings may reach logs, status, or audit metadata.
      await adapter
        .audit(owner, error instanceof ManualMovePending ? 'run_yielded_for_move' : 'run_stopped')
        .catch(() => {});
    } finally {
      const latest = await store.read(owner);
      const continuation =
        !errorMessage &&
        latest?.revision === job.revision &&
        latest.settings.enabled &&
        latest.settings.consentVersion === MAIL_CONSENT_VERSION &&
        latest.continuation?.revision === latest.revision &&
        (!latest.continuation.liveComplete ||
          (latest.settings.history?.mode !== 'off' && latest.history && !latest.history.completed))
          ? latest.continuation
          : null;
      let nextRunAt = '';
      if (latest)
        nextRunAt =
          nextMailRun(
            latest.settings,
            new Date(now().getTime() + latest.settings.intervalMinutes * 60_000),
          ) ?? '';
      if (
        continuation &&
        (continuation.mode === 'manual' || insideMailWindow(latest!.settings, now()))
      )
        nextRunAt = new Date(now().getTime() + 1000).toISOString();
      await store.release(owner, token, {
        lastRunAt: now().toISOString(),
        lastError: errorMessage,
        continuation,
        nextRunAt,
      });
      if (latest?.movePending) wakeMoves(owner);
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (now().getTime() - lastPruned >= 3600_000) {
        await store.prune(now());
        lastPruned = now().getTime();
      }
      for (const owner of await store.movesDue(now())) await processMove(owner).catch(() => {});
      for (const owner of await store.due(now())) {
        const job = await store.read(owner);
        await run(
          owner,
          job?.continuation?.mode !== 'manual',
          job?.continuation?.mode === 'manual' ? job.revision : undefined,
        ).catch(async () => {
          await store.pause(owner);
        });
      }
    } finally {
      ticking = false;
    }
  }
  async function content(owner: string, id: string): Promise<MailResultContent> {
    await adapter.authorize(owner);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
    const job = await store.read(owner);
    if (job?.settings.consentVersion !== MAIL_CONSENT_VERSION)
      throw new MailAssistantError('Bitte bestätige zuerst deine persönliche Freigabe.');
    const connection = await adapter.connection(owner);
    if (!connection.connected || !connection.mailbox || !connection.generation)
      throw new MailAssistantError('Bitte verbinde dein persönliches Microsoft-Konto erneut.');
    const result = await store.result(owner, id);
    if (!result) throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
    const guard = async () => {
      await adapter.authorize(owner);
      const latest = await store.read(owner);
      if (
        latest?.settings.consentVersion !== MAIL_CONSENT_VERSION ||
        latest.revision !== job.revision
      )
        throw new MailAssistantError(
          'Die persönliche Freigabe wurde verändert. Bitte erneut öffnen.',
        );
      const current = await adapter.connection(owner);
      if (
        !current.connected ||
        current.mailbox !== connection.mailbox ||
        current.generation !== connection.generation
      )
        throw new MailAssistantError(
          'Die Postfachverbindung wurde verändert. Bitte erneut verbinden.',
        );
      const currentResult = await store.result(owner, id);
      if (
        currentResult?.messageId !== result.messageId ||
        currentResult.conversationId !== result.conversationId ||
        currentResult.draftId !== result.draftId ||
        currentResult.draftStatus !== result.draftStatus ||
        currentResult.operationPending !== result.operationPending ||
        currentResult.moveStatus !== result.moveStatus ||
        currentResult.editPending !== result.editPending
      )
        throw new MailAssistantError(
          'Der Mail-Vorgang wurde verändert. Bitte die Übersicht aktualisieren.',
        );
    };
    await guard();
    await adapter.audit(owner, 'result_content_requested', id);
    const graph = await adapter.graph(owner, guard);
    try {
      const message = await graph.message(result.messageId);
      await guard();
      if (
        message.id !== result.messageId ||
        message.conversationId !== result.conversationId ||
        message.isDraft
      )
        throw new MailAssistantError('Die Originalmail passt nicht mehr zum Mail-Vorgang.');
      const response: MailResultContent = {
        resultId: id,
        mailbox: connection.mailbox,
        message: {
          subject: message.subject,
          sender: message.sender,
          receivedAt: message.receivedAt,
          body: message.body,
          bodyTruncated: message.bodyTruncated === true,
          preview: await graph.preview(result.messageId),
        },
      };
      await guard();
      if (result.draftId || result.draftStatus !== 'none') response.draftUnavailable = true;
      if (result.draftId && result.draftStatus === 'created' && !result.operationPending) {
        try {
          const draft = await graph.message(result.draftId);
          await guard();
          if (
            draft.id === result.draftId &&
            draft.isDraft &&
            draft.conversationId === result.conversationId
          ) {
            response.draft = {
              subject: draft.subject,
              body: draft.body,
              bodyTruncated: draft.bodyTruncated === true,
              preview: await graph.preview(result.draftId),
            };
            await guard();
            if (!result.editPending) {
              try {
                const editable = await graph.editableReply(result.draftId);
                await guard();
                response.draft.replyText = editable.text;
                response.draft.revision = hash([result.draftId, editable.etag]);
              } catch (error) {
                if (!(error instanceof MailGraphError) || ![400, 409, 412].includes(error.status))
                  throw error;
              }
            }
            delete response.draftUnavailable;
          }
        } catch (error) {
          if (!(error instanceof MailGraphError) || ![404, 410].includes(error.status)) throw error;
        }
      }
      await guard();
      await adapter.audit(owner, 'result_content_read', id);
      await guard();
      return response;
    } catch (error) {
      if (error instanceof MailGraphError) {
        throw new MailAssistantError(
          [404, 410].includes(error.status)
            ? 'Die Originalmail ist nicht mehr verfügbar. Bitte in Outlook prüfen.'
            : error.message,
        );
      }
      throw error;
    }
  }
  async function folders(owner: string, parentId?: string): Promise<MailFolder[]> {
    await adapter.authorize(owner);
    const job = await store.read(owner);
    const connection = await adapter.connection(owner);
    if (
      job?.settings.consentVersion !== MAIL_CONSENT_VERSION ||
      !connection.connected ||
      !connection.generation
    )
      throw new MailAssistantError(
        'Bitte bestätige die Freigabe und verbinde dein persönliches Postfach.',
      );
    const guard = async () => {
      await adapter.authorize(owner);
      const [current, latest] = await Promise.all([adapter.connection(owner), store.read(owner)]);
      if (
        !current.connected ||
        current.generation !== connection.generation ||
        current.mailbox !== connection.mailbox ||
        latest?.revision !== job.revision
      )
        throw new MailAssistantError(
          'Die persönliche Verbindung wurde geändert. Bitte erneut öffnen.',
        );
    };
    await adapter.audit(owner, 'folders_requested');
    const graph = await adapter.graph(owner, guard);
    const selected = await graph.folders(parentId);
    await guard();
    return selected;
  }

  async function manualLease<T>(
    owner: string,
    action: (
      token: string,
      guard: () => Promise<void>,
      job: MailJob,
      connection: { mailbox: string; generation: string },
    ) => Promise<T>,
  ): Promise<T> {
    await adapter.authorize(owner);
    const token = randomUUID();
    const job = await store.claim(owner, token, now(), true);
    if (!job)
      throw new ManualLeaseBusy(
        'Eine Mail wird gerade bearbeitet. Bitte kurz warten und erneut versuchen.',
      );
    try {
      const connection = await adapter.connection(owner);
      if (!connection.connected || !connection.generation || !connection.mailbox)
        throw new MailAssistantError('Bitte verbinde dein persönliches Microsoft-Konto erneut.');
      const guard = async () => {
        await adapter.authorize(owner);
        const [latest, current] = await Promise.all([store.read(owner), adapter.connection(owner)]);
        if (
          !latest ||
          latest.settings.consentVersion !== MAIL_CONSENT_VERSION ||
          latest.revision !== job.revision ||
          latest.leaseToken !== token ||
          !latest.leaseUntil ||
          latest.leaseUntil.getTime() <= now().getTime() ||
          !current.connected ||
          current.mailbox !== connection.mailbox ||
          current.generation !== connection.generation
        )
          throw new MailAssistantError(
            'Die persönliche Freigabe oder Verbindung wurde verändert. Bitte erneut prüfen.',
          );
        if (
          !(await store.update(owner, token, { leaseUntil: new Date(now().getTime() + 120_000) }))
        )
          throw new MailAssistantError('Die Bearbeitung wurde angehalten.');
      };
      await guard();
      return await action(token, guard, job, {
        mailbox: connection.mailbox,
        generation: connection.generation,
      });
    } finally {
      await store.release(owner, token, {});
    }
  }

  async function manualOperation<T>(
    owner: string,
    id: string,
    action: (result: StoredMailResult, token: string, guard: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
    return manualLease(owner, async (token, guard) => {
      const result = await store.result(owner, id);
      if (!result) throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
      return action(result, token, guard);
    });
  }

  async function moveWithLease(
    owner: string,
    id: string,
    folderId: string,
    revision: string,
    result: StoredMailResult,
    token: string,
    guard: () => Promise<void>,
  ): Promise<MailResult> {
    if (revision !== resultRevision(result))
      throw new MailAssistantError(
        'Der Mail-Vorgang wurde inzwischen verändert. Bitte neu laden und die angezeigte Mail erneut auswählen.',
      );
    if (result.moveStatus === 'completed') return publicResult(result);
    const operationKey = hash([owner, id, result.messageId, 'manual-move']);
    if (
      result.moveStatus === 'uncertain' ||
      (await store.draftState(owner, operationKey))?.state === 'pending'
    )
      throw new MailAssistantError(
        'Der Ausgang einer früheren Verschiebung ist unklar. Bitte in Outlook kontrollieren; es wird nicht erneut verschoben.',
      );
    const graph = await adapter.graph(owner, guard);
    const folder = await graph.folder(folderId);
    if (!folder.canMoveTo) throw new MailAssistantError('Bitte einen eigenen Ablageordner wählen.');
    const mail = await graph.message(result.messageId);
    if (
      mail.id !== result.messageId ||
      mail.conversationId !== result.conversationId ||
      mail.isDraft
    )
      throw new MailAssistantError('Die Originalmail passt nicht mehr zum Mail-Vorgang.');
    await guard();
    await adapter.audit(owner, 'manual_move_requested', id);
    const operationHash = hash([result.messageId, folder.id, mail.changeKey]);
    if (!(await store.reserveDraft(owner, token, operationKey, operationHash, true)))
      throw new MailAssistantError(
        'Diese Verschiebung wurde bereits angefordert. Bitte den Status prüfen.',
      );
    const pending = { ...result, moveStatus: 'uncertain' as const, moveDestination: folder.id };
    await store.putResult(owner, token, pending);
    try {
      const moved = await graph.move(result.messageId, folder.id, mail.etag);
      if (
        !moved.id ||
        moved.isDraft ||
        moved.conversationId !== result.conversationId ||
        moved.parentFolderId !== folder.id
      )
        throw new MailGraphError(0, true);
      await store.finishDraft(owner, operationKey, operationHash, 'completed');
      await guard();
      const completed: StoredMailResult = {
        ...result,
        messageId: moved.id,
        messageUrl: moved.messageUrl,
        sourceHash: sourceHash({ ...mail, id: moved.id }),
        moveStatus: 'completed',
        doneFolder: folder.displayName,
        moveDestination: folder.id,
      };
      await store.putResult(owner, token, completed);
      await adapter.audit(owner, 'manual_move_completed', id);
      return publicResult(completed);
    } catch (error) {
      if (error instanceof MailGraphError && !error.uncertain) {
        await store.finishDraft(owner, operationKey, operationHash, 'failed');
        await store.putResult(owner, token, result);
      }
      throw error;
    }
  }

  async function move(
    owner: string,
    id: string,
    folderId: string,
    revision: string,
  ): Promise<MailResult> {
    return manualOperation(owner, id, (result, token, guard) =>
      moveWithLease(owner, id, folderId, revision, result, token, guard),
    );
  }

  async function moveJobs(owner: string): Promise<MailMoveJob[]> {
    await adapter.authorize(owner);
    await store.cancelStaleMoves(owner, now());
    return (await store.moveJobs(owner)).map(publicMoveJob).reverse();
  }

  async function enqueueMove(owner: string, input: MailMoveRequest): Promise<MailMoveJob> {
    await adapter.authorize(owner);
    const request = z
      .object({
        requestId: z.string().uuid(),
        folderId: z
          .string()
          .min(1)
          .max(2048)
          .regex(/^[A-Za-z0-9_+=/-]+$/),
        items: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-f0-9]{64}$/),
                revision: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(input);
    if (new Set(request.items.map((item) => item.id)).size !== request.items.length)
      throw new MailAssistantError('Jede Mail darf nur einmal ausgewählt werden.');
    const [job, connection] = await Promise.all([store.read(owner), adapter.connection(owner)]);
    if (
      !job ||
      job.settings.consentVersion !== MAIL_CONSENT_VERSION ||
      !connection.connected ||
      !connection.generation ||
      !connection.mailbox
    )
      throw new MailAssistantError(
        'Bitte bestätige die persönliche Freigabe und verbinde dein Postfach.',
      );
    await store.cancelStaleMoves(owner, now());
    const requestHash = hash(request);
    const existing = (await store.moveJobs(owner)).find((item) => item.id === request.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new MailAssistantError(
          'Die Auftragskennung gehört zu einer anderen Auswahl. Bitte neu auswählen.',
        );
      return publicMoveJob(existing);
    }
    const selected = await Promise.all(
      request.items.map(async (item) => {
        const result = await store.result(owner, item.id);
        if (!result || resultRevision(result) !== item.revision)
          throw new MailAssistantError(
            'Eine ausgewählte Mail wurde verändert. Bitte die Liste neu laden und erneut auswählen.',
          );
        if (result.moveStatus)
          throw new MailAssistantError(
            'Eine ausgewählte Mail wurde bereits verschoben oder ihr Ablagestatus ist unklar. Bitte prüfen.',
          );
        return { ...item, subject: result.subject.slice(0, 500), status: 'queued' as const };
      }),
    );
    const queued: StoredMailMoveJob = {
      id: request.requestId,
      requestHash,
      folderId: request.folderId,
      folderName: '',
      settingsRevision: job.revision,
      connectionGeneration: connection.generation,
      mailbox: connection.mailbox,
      items: selected,
      total: selected.length,
      completed: 0,
      failed: 0,
      status: 'queued',
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    };
    await adapter.audit(owner, 'manual_move_job_requested', queued.id);
    const current = await adapter.connection(owner);
    if (
      !current.connected ||
      current.generation !== connection.generation ||
      current.mailbox !== connection.mailbox
    )
      throw new MailAssistantError('Die Verbindung wurde geändert. Bitte erneut auswählen.');
    const accepted = await store.enqueueMove(owner, queued);
    if (accepted === 'revoked')
      throw new MailAssistantError(
        'Die persönliche Freigabe wurde geändert. Bitte erneut auswählen.',
      );
    if (accepted === 'busy')
      throw new MailAssistantError(
        'Ein Verschiebeauftrag läuft bereits oder die Auftragskennung ist belegt. Bitte dessen Abschluss abwarten.',
      );
    wakeMoves(owner);
    const saved = (await store.moveJobs(owner)).find((item) => item.id === queued.id);
    if (!saved) throw new MailAssistantError('Die Verbindung wurde während der Annahme getrennt.');
    return publicMoveJob(saved);
  }

  async function processMove(owner: string): Promise<void> {
    await store.cancelStaleMoves(owner, now());
    const pending = (await store.moveJobs(owner)).find(activeMoveJob);
    if (!pending) return;
    try {
      await manualLease(owner, async (token, leaseGuard, job, connection) => {
        let queue = (await store.moveJobs(owner)).find((item) => item.id === pending.id);
        if (!queue || !activeMoveJob(queue) || job.revision !== queue.settingsRevision) return;
        if (
          connection.mailbox !== queue.mailbox ||
          connection.generation !== queue.connectionGeneration
        )
          throw new MailAssistantError('Die Verbindung des Verschiebeauftrags wurde geändert.');
        const queueId = queue.id;
        const guard = async () => {
          await leaseGuard();
          const current = (await store.moveJobs(owner)).find((item) => item.id === queueId);
          if (!current || !activeMoveJob(current))
            throw new MailAssistantError('Der Verschiebeauftrag wurde angehalten.');
        };
        const save = async () => {
          queue = summarizeMove(queue!, now());
          if (!(await store.updateMove(owner, token, queue)))
            throw new MailAssistantError('Der Verschiebeauftrag wurde angehalten.');
        };
        const interrupted = queue.items.find((item) => item.status === 'running');
        if (interrupted) {
          const stored = await store.result(owner, interrupted.id);
          if (stored?.moveStatus === 'completed' && stored.moveDestination === queue.folderId) {
            interrupted.status = 'completed';
          } else {
            interrupted.status = 'uncertain';
            interrupted.error =
              'Die vorige Bearbeitung wurde unterbrochen. Bitte in Outlook prüfen; keine automatische Wiederholung.';
          }
          await save();
          return;
        }
        const item = queue.items.find((entry) => entry.status === 'queued');
        if (!item) return;
        if (!queue.folderName) {
          try {
            const graph = await adapter.graph(owner, guard);
            const folder = await graph.folder(queue.folderId);
            await guard();
            if (!folder.canMoveTo || folder.id !== queue.folderId)
              throw new MailAssistantError('Bitte einen eigenen gültigen Ablageordner wählen.');
            queue.folderName = folder.displayName;
          } catch {
            queue.items = queue.items.map((entry) =>
              entry.status === 'queued'
                ? {
                    ...entry,
                    status: 'failed',
                    error:
                      'Der Zielordner konnte nicht bestätigt werden. Bitte Verbindung und Ordnerauswahl prüfen.',
                  }
                : entry,
            );
            await save();
            return;
          }
        }
        await adapter.audit(owner, 'manual_move_item_started', item.id);
        await guard();
        item.status = 'running';
        await save();
        try {
          const result = await store.result(owner, item.id);
          if (!result) throw new MailAssistantError('Mail-Vorgang nicht mehr vorhanden.');
          const moved = await moveWithLease(
            owner,
            item.id,
            queue.folderId,
            item.revision,
            result,
            token,
            guard,
          );
          item.status = 'completed';
          queue.folderName = moved.doneFolder ?? queue.folderName;
        } catch (error) {
          const result = await store.result(owner, item.id);
          const uncertain =
            result?.moveStatus === 'uncertain' ||
            (error instanceof MailGraphError && error.uncertain);
          item.status = uncertain ? 'uncertain' : 'failed';
          if (uncertain)
            item.error =
              'Der Ausgang der Verschiebung ist unklar. Bitte in Outlook prüfen; keine automatische Wiederholung.';
          else if (error instanceof MailAssistantError || error instanceof MailGraphError)
            item.error = error.message;
          else
            item.error =
              'Die Mail konnte nicht verschoben werden. Bitte prüfen und bei Bedarf neu auswählen.';
          if (
            uncertain ||
            !(error instanceof MailAssistantError) ||
            (error instanceof MailGraphError && [401, 403, 429].includes(error.status))
          ) {
            queue.items = queue.items.map((entry) =>
              entry.status === 'queued'
                ? {
                    ...entry,
                    status: 'cancelled',
                    error:
                      'Nach einem Verbindungs- oder Schreibfehler angehalten. Bitte neu auswählen.',
                  }
                : entry,
            );
          }
        }
        await save();
      });
    } catch (error) {
      if (!(error instanceof ManualLeaseBusy)) {
        await store.cancelStaleMoves(owner, now(), pending.id);
        await adapter.audit(owner, 'manual_move_job_stopped', pending.id).catch(() => {});
      }
    } finally {
      if ((await store.read(owner))?.movePending) wakeMoves(owner);
    }
  }

  async function editDraft(
    owner: string,
    id: string,
    body: string,
    revision: string,
  ): Promise<void> {
    if (!body.trim() || body.length > 12000 || !/^[a-f0-9]{64}$/.test(revision))
      throw new MailAssistantError(
        'Bitte einen vollständigen Antworttext mit höchstens 12000 Zeichen eingeben.',
      );
    await manualOperation(owner, id, async (result, token, guard) => {
      if (
        !result.draftId ||
        result.draftStatus !== 'created' ||
        result.operationPending ||
        result.editPending
      )
        throw new MailAssistantError(
          'Dieser Entwurf kann nicht sicher geändert werden. Bitte direkt in Outlook prüfen.',
        );
      const graph = await adapter.graph(owner, guard);
      const draft = await graph.message(result.draftId);
      if (
        !draft.isDraft ||
        draft.id !== result.draftId ||
        draft.conversationId !== result.conversationId
      )
        throw new MailAssistantError('Der Entwurf wurde inzwischen verändert oder versendet.');
      const editable = await graph.editableReply(result.draftId);
      if (hash([result.draftId, editable.etag]) !== revision)
        throw new MailAssistantError(
          'Der Entwurf wurde inzwischen geändert. Bitte zuerst neu laden; deine Änderungen wurden nicht gespeichert.',
        );
      const operationKey = hash([owner, id, result.draftId, 'manual-draft-edit']);
      if ((await store.draftState(owner, operationKey))?.state === 'pending')
        throw new MailAssistantError(
          'Der Ausgang der letzten Speicherung ist unklar. Bitte in Outlook prüfen.',
        );
      await adapter.audit(owner, 'manual_draft_edit_requested', id);
      await guard();
      if (!(await store.reserveDraft(owner, token, operationKey, revision, true)))
        throw new MailAssistantError('Diese Änderung wurde bereits angefordert. Bitte neu laden.');
      await store.putResult(owner, token, { ...result, editPending: true });
      try {
        await graph.editDraft(result.draftId, body, editable.etag);
        await store.finishDraft(owner, operationKey, revision, 'completed');
        await guard();
        await store.putResult(owner, token, { ...result, editPending: false });
        await adapter.audit(owner, 'manual_draft_edit_completed', id);
      } catch (error) {
        if (error instanceof MailGraphError && !error.uncertain) {
          await store.finishDraft(owner, operationKey, revision, 'failed');
          await store.putResult(owner, token, { ...result, editPending: false });
        }
        throw error;
      }
    });
  }

  async function rememberRule(owner: string, id: string, input: MailRuleInput): Promise<void> {
    const rule = z
      .object({
        text: z.string().trim().min(12).max(2400),
        scope: z.enum(['sender', 'global']),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    await manualOperation(owner, id, async (result, _token, guard) => {
      if (rule.revision !== resultRevision(result))
        throw new MailAssistantError(
          'Die Mail wurde inzwischen geändert. Bitte neu laden und die Regel erneut prüfen.',
        );
      if (!adapter.rememberRule)
        throw new MailAssistantError('Persönliche Mailregeln sind derzeit nicht verfügbar.');
      await guard();
      await adapter.audit(owner, 'personal_rule_requested', id);
      await guard();
      await adapter.rememberRule(owner, {
        text: rule.text,
        scope: rule.scope,
        sender: result.sender,
      });
      await adapter.audit(owner, 'personal_rule_saved', id);
    });
  }

  async function results(owner: string, query: MailResultQuery): Promise<MailResultPage> {
    await adapter.authorize(owner);
    const parsed = z
      .object({
        cursor: z.string().max(1024).optional(),
        search: z.string().max(200).optional(),
        priority: z.enum(['important', 'normal', 'low']).optional(),
        state: z.enum(['open', 'done', 'all']).optional(),
      })
      .strict()
      .parse(query);
    const fingerprint = hash([
      owner,
      parsed.search ?? '',
      parsed.priority ?? '',
      parsed.state ?? 'all',
    ]);
    let after: { receivedAt: string; id: string } | undefined;
    if (parsed.cursor) {
      try {
        const cursor = z
          .object({
            fingerprint: z.string(),
            receivedAt: z.string().datetime(),
            id: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString()));
        if (cursor.fingerprint !== fingerprint) throw Error();
        after = cursor;
      } catch {
        throw new MailAssistantError('Die Ergebnisliste wurde verändert. Bitte erneut laden.');
      }
    }
    const search = parsed.search?.toLocaleLowerCase('de-CH') ?? '';
    const filtered = (await store.results(owner))
      .filter(
        (item) =>
          (!parsed.priority || item.priority === parsed.priority) &&
          (parsed.state !== 'done' || item.moveStatus === 'completed') &&
          (parsed.state !== 'open' || item.moveStatus !== 'completed') &&
          (!search ||
            `${item.subject}\n${item.sender}\n${item.summary}`
              .toLocaleLowerCase('de-CH')
              .includes(search)) &&
          (!after ||
            item.receivedAt < after.receivedAt ||
            (item.receivedAt === after.receivedAt && item.id > after.id)),
      )
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
    const selected = filtered.slice(0, 50);
    const last = selected[selected.length - 1];
    return {
      results: selected.map(publicResult),
      ...(filtered.length > 50 &&
        last && {
          nextCursor: Buffer.from(
            JSON.stringify({ fingerprint, receivedAt: last.receivedAt, id: last.id }),
          ).toString('base64url'),
        }),
    };
  }
  return {
    content,
    enqueueMove,
    moveJobs,
    results,
    folders,
    move,
    editDraft,
    rememberRule,
    async status(owner: string) {
      await adapter.authorize(owner);
      const availability = await adapter.availability(owner);
      const job = await store.read(owner);
      const connection = await adapter.connection(owner);
      return {
        ...availability,
        connection: {
          connected: connection.connected,
          ...(connection.mailbox ? { mailbox: connection.mailbox } : {}),
        },
        settings: {
          ...(job?.settings ?? defaultMailSettings()),
          history: job?.settings.history ?? { mode: 'off' },
        },
        activity: {
          running:
            (!!job?.leaseUntil && job.leaseUntil.getTime() > now().getTime()) ||
            !!job?.continuation,
          continuing: !!job?.continuation,
          lastRunAt: job?.lastRunAt,
          nextRunAt: job?.nextRunAt || undefined,
          lastError: job?.lastError || undefined,
          pending: job?.checkpoint?.pending.length ?? 0,
          hasMore:
            !!job?.checkpoint?.pending.length ||
            (job?.checkpoint?.hasMore ?? !!(job?.checkpoint?.url || job?.checkpoint?.nextUrl)),
          history: {
            mode: job?.settings.history?.mode ?? 'off',
            processed: job?.history?.processed ?? 0,
            pending: job?.history?.pending.length ?? 0,
            hasMore: !!job?.history && !job.history.completed,
            completed: job?.history?.completed ?? false,
            ...(job?.history?.from && { from: job.history.from }),
            ...(job?.history?.until && { until: job.history.until }),
          },
        },
        results: (await store.results(owner)).slice(0, 200).map(publicResult),
      };
    },
    async settings(owner: string, input: unknown) {
      await available(owner);
      const parsed = mailSettingsSchema.safeParse(input);
      if (!parsed.success)
        throw new MailAssistantError(
          'Bitte bestätige die Freigabe und prüfe Wochentage, Zeitzone und Arbeitszeiten.',
        );
      if (parsed.data.enabled && !(await adapter.connection(owner)).connected)
        throw new MailAssistantError('Bitte verbinde zuerst dein persönliches Microsoft-Konto.');
      if (parsed.data.history?.mode === 'since') {
        const existing = await store.read(owner);
        let from: string;
        try {
          from = mailHistoryStart(parsed.data.history.from!, parsed.data.timeZone);
        } catch {
          throw new MailAssistantError('Bitte ein gültiges Startdatum in deiner Zeitzone wählen.');
        }
        if (Date.parse(from) >= Date.parse(existing?.enabledAt ?? now().toISOString()))
          throw new MailAssistantError(
            'Das Startdatum muss vor der ersten persönlichen Aktivierung liegen. Neuere Eingänge gehören bereits zur laufenden Prüfung.',
          );
      }
      await adapter.audit(owner, parsed.data.enabled ? 'settings_enabled' : 'settings_disabled');
      await store.saveSettings(owner, parsed.data, now());
      await store.cancelStaleMoves(owner, now());
    },
    run,
    async pause(owner: string) {
      await adapter.authorize(owner);
      await store.pause(owner);
      await store.cancelStaleMoves(owner, now());
      await adapter.audit(owner, 'paused');
    },
    async disconnect(owner: string) {
      await adapter.authorize(owner);
      await store.pause(owner);
      await store.purge(owner);
      await adapter.audit(owner, 'local_data_deleted');
    },
    async priority(owner: string, id: string, priority: MailPriority) {
      if (!Object.prototype.hasOwnProperty.call(MAIL_CATEGORIES, priority))
        throw new MailAssistantError('Ungültige Priorität.');
      await manualOperation(owner, id, async (result, token, guard) => {
        const graph = await adapter.graph(owner, guard);
        const mail = await graph.message(result.messageId);
        if (
          mail.id !== result.messageId ||
          mail.conversationId !== result.conversationId ||
          mail.isDraft
        )
          throw new MailAssistantError('Die Originalmail passt nicht mehr zum Mail-Vorgang.');
        const categories = (current: string[]) => [
          ...new Set([
            ...current.filter((value) => !Object.values(MAIL_CATEGORIES).includes(value)),
            MAIL_CATEGORIES[priority],
          ]),
        ];
        await adapter.audit(owner, 'manual_category_requested', id);
        await graph.categorize(result.messageId, categories(mail.categories), mail.etag);
        if (
          result.draftId &&
          result.draftStatus === 'created' &&
          !result.operationPending &&
          !result.editPending
        ) {
          try {
            const draft = await graph.message(result.draftId);
            if (
              draft.id === result.draftId &&
              draft.isDraft &&
              draft.conversationId === result.conversationId
            ) {
              await adapter.audit(owner, 'manual_draft_category_requested', id);
              await graph.categorize(result.draftId, categories(draft.categories), draft.etag);
            }
          } catch (error) {
            if (!(error instanceof MailGraphError) || ![404, 410].includes(error.status))
              throw error;
          }
        }
        await adapter.audit(owner, 'manual_category_completed', id);
        await guard();
        await store.putResult(owner, token, {
          ...result,
          priority,
          manualPriority: true,
          categoryApplied: true,
        });
      });
    },
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => {
          void tick().catch(() => {});
        }, 5000);
        timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const timeout of moveWakeups.values()) clearTimeout(timeout);
      moveWakeups.clear();
    },
  };
}
