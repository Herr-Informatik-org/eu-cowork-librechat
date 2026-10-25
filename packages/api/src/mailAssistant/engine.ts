import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  MailAnalysis,
  MailAssistantEngine,
  MailJob,
  MailMessage,
  MailPriority,
  MailResult,
  MailRuntimeAdapter,
  MailStore,
  StoredMailResult,
} from './types';
import { MAIL_CATEGORIES, MAIL_CONSENT_VERSION } from './types';
import { defaultMailSettings, insideMailWindow, mailSettingsSchema, nextMailRun } from './schedule';
import { MailGraphError } from './graph';

export class MailAssistantError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceHash = (mail: MailMessage) =>
  hash([mail.id, mail.subject, mail.sender, mail.receivedAt, mail.body]);
export const mailAnalysisSchema: z.ZodType<MailAnalysis> = z
  .object({
    priority: z.enum(['important', 'normal', 'low']),
    action: z.enum(['reply', 'review', 'information']),
    summary: z.string().min(1).max(1600),
    reason: z.string().min(1).max(800),
    questions: z.array(z.string().min(1).max(500)).max(10),
    draft: z.string().max(12000),
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
    ...result
  } = value;
  return { ...result, ...(value.operationPending && { draftStatus: 'uncertain' as const }) };
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
  ) {
    const graph = await adapter.graph(owner, guard);
    let mail: MailMessage;
    try {
      mail = await graph.message(id);
    } catch (error) {
      if (error instanceof MailGraphError && error.status === 404) return;
      throw error;
    }
    if (mail.isDraft || Date.parse(mail.receivedAt) < Date.parse(job.enabledAt!)) return;
    const resultId = hash([owner, mail.conversationId]);
    const previous = await store.result(owner, resultId);
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
      draftStatus: uncertain
        ? 'uncertain'
        : existing
          ? previous?.draftId === existing.id
            ? 'stale'
            : 'existing'
          : 'none',
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
      result.operationPending = false;
      await adapter.audit(owner, 'draft_completed', resultId);
      await guard();
      await store.putResult(owner, token, result);
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
  async function run(owner: string, scheduled = false) {
    await available(owner);
    const initial = await store.read(owner);
    if (!initial?.settings.enabled || !initial.enabledAt)
      throw new MailAssistantError('Bitte aktiviere zuerst deine persönliche Mailverarbeitung.');
    const token = randomUUID();
    const job = await store.claim(owner, token, now());
    if (!job) {
      if (scheduled) return;
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
      let checkpoint = job.checkpoint ?? { pending: [] };
      const graph = await adapter.graph(owner, guard);
      if (!checkpoint.pending.length) {
        const page = await graph.page(job.enabledAt!, checkpoint.url);
        checkpoint = {
          ...checkpoint,
          pending: [...new Set(page.messages.map((item) => item.id))],
          nextUrl: page.nextUrl,
        };
        if (!(await store.update(owner, token, { checkpoint })))
          throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
      }
      const deadline = now().getTime() + 4 * 60_000;
      for (
        let count = 0;
        checkpoint.pending.length && count < 20 && now().getTime() < deadline;
        count++
      ) {
        await guard();
        await process(owner, job, token, checkpoint.pending[0], guard);
        checkpoint.pending.shift();
        if (!checkpoint.pending.length) checkpoint = { pending: [], url: checkpoint.nextUrl };
        if (!(await store.update(owner, token, { checkpoint })))
          throw new MailAssistantError('Die Verarbeitung wurde angehalten.');
      }
      if (!checkpoint.pending.length && checkpoint.nextUrl)
        await store.update(owner, token, { checkpoint: { pending: [], url: checkpoint.nextUrl } });
      await adapter.audit(owner, 'run_completed');
    } catch (error) {
      errorMessage =
        error instanceof MailGraphError || error instanceof MailAssistantError
          ? error.message
          : 'Die Mailprüfung wurde angehalten. Bitte prüfe Verbindung, Modellfreigabe und Guthaben. Es wird nichts automatisch versendet.';
      // No source data or provider error strings may reach logs, status, or audit metadata.
      await adapter.audit(owner, 'run_stopped').catch(() => {});
    } finally {
      const latest = await store.read(owner);
      await store.release(owner, token, {
        lastRunAt: now().toISOString(),
        lastError: errorMessage,
        nextRunAt: latest
          ? (nextMailRun(
              latest.settings,
              new Date(now().getTime() + latest.settings.intervalMinutes * 60_000),
            ) ?? '')
          : '',
      });
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
      for (const owner of await store.due(now())) {
        await run(owner, true).catch(async () => {
          await store.pause(owner);
        });
      }
    } finally {
      ticking = false;
    }
  }
  return {
    async status(owner: string) {
      await adapter.authorize(owner);
      const availability = await adapter.availability(owner);
      const job = await store.read(owner);
      return {
        ...availability,
        connection: await adapter.connection(owner),
        settings: {
          ...(job?.settings ?? defaultMailSettings()),
        },
        activity: {
          running: !!job?.leaseUntil && job.leaseUntil.getTime() > now().getTime(),
          lastRunAt: job?.lastRunAt,
          nextRunAt: job?.nextRunAt || undefined,
          lastError: job?.lastError || undefined,
          pending: job?.checkpoint?.pending.length ?? 0,
        },
        results: (await store.results(owner)).map(publicResult),
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
      await adapter.audit(owner, parsed.data.enabled ? 'settings_enabled' : 'settings_disabled');
      await store.saveSettings(owner, parsed.data, now());
    },
    run,
    async pause(owner: string) {
      await adapter.authorize(owner);
      await store.pause(owner);
      await adapter.audit(owner, 'paused');
    },
    async disconnect(owner: string) {
      await adapter.authorize(owner);
      await store.pause(owner);
      await store.purge(owner);
      await adapter.audit(owner, 'local_data_deleted');
    },
    async priority(owner: string, id: string, priority: MailPriority) {
      await available(owner);
      if (!Object.prototype.hasOwnProperty.call(MAIL_CATEGORIES, priority))
        throw new MailAssistantError('Ungültige Priorität.');
      const token = randomUUID();
      const job = await store.claim(owner, token, now());
      if (!job)
        throw new MailAssistantError(
          'Bitte aktiviere die Verarbeitung oder warte bis zum Ende der laufenden Prüfung.',
        );
      try {
        const result = await store.result(owner, id);
        if (!result) throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
        const guard = () => active(owner, job, token, false);
        const graph = await adapter.graph(owner, guard);
        const mail = await graph.message(result.messageId);
        const categories = mail.categories.filter(
          (value) => !Object.values(MAIL_CATEGORIES).includes(value),
        );
        await adapter.audit(owner, 'manual_category_requested', id);
        await graph.categorize(
          result.messageId,
          [...new Set([...categories, MAIL_CATEGORIES[priority]])],
          mail.etag,
        );
        await adapter.audit(owner, 'manual_category_completed', id);
        await guard();
        await store.putResult(owner, token, {
          ...result,
          priority,
          manualPriority: true,
          categoryApplied: true,
        });
      } finally {
        await store.release(owner, token, {});
      }
    },
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => {
          void tick().catch(() => {});
        }, 60_000);
        timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
