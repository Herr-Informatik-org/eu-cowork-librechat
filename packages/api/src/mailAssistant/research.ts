import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Collection } from 'mongodb';
import type {
  MailResearchJob,
  MailResearchSkill,
  MailResearchSettings,
  MailResearchRunRequest,
  MailResearchEvidence,
} from 'librechat-data-provider';
import { MAIL_RESEARCH_CONSENT_VERSION } from 'librechat-data-provider';
import type { MailCodec } from './privateData';
import type { MailMessage, MailRuntimeAdapter, MailStore } from './types';
import { MAIL_CONSENT_VERSION } from './types';
import { MailAssistantError, resultRevision } from './engine';
import type { createMailResearchMcp } from './researchMcp';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const profileId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const literal = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[^%_*\r\n\x00-\x1f]+$/); // eslint-disable-line no-control-regex
export const researchSkillSchema = z
  .object({
    expectedRevision: z.union([revision, z.literal('')]),
    name: z.string().trim().min(1).max(100),
    instructions: z.string().trim().min(1).max(4000),
    topic: literal,
    lookbackMonths: z.number().int().min(1).max(36),
    sources: z
      .array(z.enum(['odoo', 'ops']))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    consentVersion: z.literal(MAIL_RESEARCH_CONSENT_VERSION),
  })
  .strict();
export const researchRunSchema = z
  .object({
    requestId: z.string().uuid(),
    revision,
    skillId,
    skillRevision: revision,
    selections: z
      .array(z.object({ profileId, customerId: z.string().min(1).max(128) }).strict())
      .min(1)
      .max(2),
    customersConfirmed: z.literal(true),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(120)
      // eslint-disable-next-line no-control-regex -- Search literals cannot inject query syntax or control bytes.
      .regex(/^[^%_*\r\n\x00-\x1f]+$/)
      .optional(),
  })
  .strict();
interface StoredJob {
  view: MailResearchJob;
  input: MailResearchRunRequest;
  requestHash: string;
  skill: MailResearchSkill;
  generation: string;
  mailbox: string;
  mailSettingsRevision: number;
  modelFingerprint: string;
  sourceId: string;
  changeKey: string;
}
interface State {
  skills: MailResearchSkill[];
  consentVersion?: string;
  jobs: StoredJob[];
}
export interface ResearchRow {
  _id: string;
  ownerId: string;
  version: number;
  encrypted: string;
  activeJobId?: string;
  leaseToken?: string;
  leaseUntil?: Date;
  nextCleanupAt?: Date;
}
interface Dependencies {
  collection(): Collection<ResearchRow>;
  codec: MailCodec;
  store: MailStore;
  adapter: MailRuntimeAdapter;
  mcp: ReturnType<typeof createMailResearchMcp>;
  analyze(
    owner: string,
    mail: MailMessage,
    skill: MailResearchSkill,
    evidence: MailResearchEvidence[],
    guard: () => Promise<void>,
    limitations: { sources: MailResearchJob['sources']; warnings: string[] },
  ): Promise<string>;
  now?: () => Date;
}
const busy = () =>
  new MailAssistantError(
    'Deine vorige Recherche läuft noch. Bitte anhalten oder abschliessen lassen.',
  );
const denied = () =>
  new MailAssistantError(
    'Die Recherche ist nicht mehr freigegeben oder die Quelle wurde geändert. Bitte neu starten.',
  );
const active = (job: StoredJob) => ['queued', 'running'].includes(job.view.status);

/** Personal encrypted snapshots, lease-fenced jobs and fixed source reads. Mail text grants no authority. */
export function createMailResearch(deps: Dependencies) {
  const now = deps.now ?? (() => new Date());
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  const decode = (row: ResearchRow): State =>
    deps.codec.open(row.ownerId, 'research', row.encrypted);
  const read = async (owner: string) => {
    const row = await deps.collection().findOne({ _id: owner, ownerId: owner });
    return { row, state: row ? decode(row) : ({ skills: [], jobs: [] } as State) };
  };
  const mutate = async <T>(owner: string, change: (state: State, row: ResearchRow | null) => T) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { row, state } = await read(owner);
      const result = change(state, row);
      const activeJob = state.jobs.find(active);
      const completedDates = state.jobs
        .filter((job) => !active(job))
        .map((job) => Date.parse(job.view.createdAt));
      const value: ResearchRow = {
        _id: owner,
        ownerId: owner,
        version: (row?.version ?? 0) + 1,
        encrypted: deps.codec.seal(owner, 'research', state),
        ...(activeJob && { activeJobId: activeJob.view.id }),
        ...(completedDates.length && {
          nextCleanupAt: new Date(Math.min(...completedDates) + 30 * 86400000),
        }),
        ...(activeJob &&
          row?.leaseToken && { leaseToken: row.leaseToken, leaseUntil: row.leaseUntil }),
      };
      if (!row) {
        try {
          await deps.collection().insertOne(value);
          return result;
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
        }
      } else if (
        (
          await deps
            .collection()
            .replaceOne({ _id: owner, ownerId: owner, version: row.version }, value)
        ).modifiedCount === 1
      )
        return result;
    }
    throw new MailAssistantError('Die Recherche wurde gleichzeitig geändert. Bitte neu laden.');
  };
  const profiles = async (owner: string) => {
    await deps.adapter.authorize(owner);
    return deps.mcp.profiles(owner);
  };
  const permitted = async (owner: string, job: StoredJob) => {
    const list = await profiles(owner);
    if (job.view.sources.some((s) => !list.some((p) => p.id === s.profileId && p.kind === s.kind)))
      throw denied();
  };
  const snapshot = async (owner: string, id: string, expected: string) => {
    await deps.adapter.authorize(owner);
    const [settings, connection, result, model] = await Promise.all([
      deps.store.read(owner),
      deps.adapter.connection(owner),
      deps.store.result(owner, id),
      deps.adapter.availability(owner),
    ]);
    if (
      !settings ||
      settings.settings.consentVersion !== MAIL_CONSENT_VERSION ||
      !connection.connected ||
      !connection.mailbox ||
      !connection.generation ||
      !result ||
      resultRevision(result) !== expected ||
      result.mailboxLocation === 'sent' ||
      result.operationPending ||
      result.moveStatus ||
      result.editPending ||
      (result.connectionGeneration && result.connectionGeneration !== connection.generation) ||
      !model.available ||
      !model.modelFingerprint
    )
      throw denied();
    return { settings, connection, result, model };
  };
  const guardJob = async (owner: string, job: StoredJob, token?: string) => {
    const { row, state } = await read(owner);
    const current = state.jobs.find((j) => j.view.id === job.view.id);
    if (
      !current ||
      state.consentVersion !== MAIL_RESEARCH_CONSENT_VERSION ||
      !state.skills.some((s) => s.id === job.skill.id && s.revision === job.skill.revision) ||
      (token &&
        (row?.leaseToken !== token ||
          !active(current) ||
          !row.leaseUntil ||
          row.leaseUntil.getTime() <= now().getTime()))
    )
      throw denied();
    await permitted(owner, job);
    const check = await snapshot(owner, job.view.resultId, job.input.revision);
    if (
      check.connection.generation !== job.generation ||
      check.connection.mailbox !== job.mailbox ||
      check.settings.revision !== job.mailSettingsRevision ||
      check.model.modelFingerprint !== job.modelFingerprint ||
      check.result.messageId !== job.sourceId
    )
      throw denied();
    return check;
  };
  const checkOriginal = async (owner: string, job: StoredJob, guard: () => Promise<void>) => {
    const graph = await deps.adapter.graph(owner, guard);
    const mail = await graph.message(job.sourceId);
    await guard();
    if (
      mail.id !== job.sourceId ||
      mail.isDraft ||
      mail.changeKey !== job.changeKey ||
      mail.bodyTruncated ||
      Buffer.byteLength(JSON.stringify(mail), 'utf8') > 20000
    )
      throw denied();
    return mail;
  };
  const publish = async (owner: string, job: StoredJob, token: string) =>
    mutate(owner, (state, row) => {
      const index = state.jobs.findIndex((j) => j.view.id === job.view.id);
      if (
        index < 0 ||
        row?.leaseToken !== token ||
        !row.leaseUntil ||
        row.leaseUntil <= now() ||
        !active(state.jobs[index])
      )
        throw denied();
      state.jobs[index] = job;
    });
  async function execute(owner: string) {
    if (running.has(owner) || running.size >= 2) return;
    running.add(owner);
    const token = randomUUID();
    let job: StoredJob | undefined;
    try {
      const row = await deps.collection().findOneAndUpdate(
        {
          _id: owner,
          ownerId: owner,
          activeJobId: { $exists: true },
          $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now() } }],
        },
        {
          $set: { leaseToken: token, leaseUntil: new Date(now().getTime() + 240000) },
          $inc: { version: 1 },
        },
        { returnDocument: 'after' },
      );
      if (!row) return;
      job = decode(row).jobs.find((j) => j.view.id === row.activeJobId && active(j));
      if (!job) return;
      // Restarted incomplete jobs stop visibly instead of silently repeating external queries.
      if (
        job.view.status === 'running' ||
        Date.parse(job.view.createdAt) < now().getTime() - 86400000
      )
        throw denied();
      const selected = job;
      const deadline = now().getTime() + 180000;
      const guard = async () => {
        if (now().getTime() > deadline)
          throw new MailAssistantError(
            'Die Recherchezeit ist abgelaufen. Bitte die Frage eingrenzen.',
          );
        await guardJob(owner, selected, token);
      };
      await guard();
      selected.view.status = 'running';
      await publish(owner, selected, token);
      let mail = await checkOriginal(owner, selected, guard);
      const collected: MailResearchEvidence[] = [];
      let bytes = 0;
      for (const source of selected.view.sources) {
        await guard();
        const choice = selected.input.selections.find((s) => s.profileId === source.profileId)!;
        const result = await deps.mcp.read(
          owner,
          source.profileId,
          choice.customerId,
          {
            topic: selected.skill.topic,
            lookbackMonths: selected.skill.lookbackMonths,
            reference: selected.input.reference,
          },
          guard,
        );
        if (result.customer.id !== choice.customerId) throw denied();
        source.customer = result.customer;
        source.status = 'complete';
        source.truncated = result.truncated;
        selected.view.warnings.push(...result.warnings.slice(0, 8));
        for (const item of result.evidence) {
          const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
          if (collected.length >= 60 || bytes + size > 36000) {
            source.truncated = true;
            continue;
          }
          if (
            item.profileId !== source.profileId ||
            item.customerId !== result.customer.id ||
            item.source !== source.kind
          )
            throw denied();
          collected.push(item);
          bytes += size;
        }
      }
      if (selected.view.sources.length === 2) {
        const mappings = selected.view.sources.map((s) => s.customer?.odooPartnerId);
        if (!mappings[0] || mappings[0] !== mappings[1])
          throw new MailAssistantError(
            'Die Kunden der ausgewählten Quellen sind nicht eindeutig demselben Odoo-Kunden zugeordnet. Es wurde kein Bericht erstellt.',
          );
      }
      await guard();
      mail = await checkOriginal(owner, selected, guard);
      selected.view.evidence = collected;
      if (selected.view.sources.some((s) => s.truncated))
        selected.view.warnings.push(
          'Die Quellenauswahl ist begrenzt und möglicherweise unvollständig.',
        );
      selected.view.answer = await deps.analyze(owner, mail, selected.skill, collected, guard, {
        sources: selected.view.sources,
        warnings: selected.view.warnings,
      });
      await guard();
      await checkOriginal(owner, selected, guard);
      selected.view.status = 'completed';
      selected.view.completedAt = now().toISOString();
      await deps.adapter.audit(owner, 'research_completed', selected.view.id);
      await publish(owner, selected, token);
    } catch (error) {
      if (job) {
        job.view.status = 'failed';
        job.view.completedAt = now().toISOString();
        job.view.error =
          error instanceof MailAssistantError
            ? error.message
            : 'Die Recherche konnte nicht vollständig und mit unveränderter Freigabe abgeschlossen werden. Bitte Kundenwahl, Quellenrechte und Status prüfen.';
        job.view.evidence = [];
        job.view.warnings = [];
        delete job.view.answer;
        job.view.sources = job.view.sources.map((s) => ({
          profileId: s.profileId,
          kind: s.kind,
          status: 'unavailable',
        }));
        await publish(owner, job, token).catch(() => undefined);
      }
    } finally {
      running.delete(owner);
    }
  }
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const expired = await deps
        .collection()
        .find({ nextCleanupAt: { $lte: now() } })
        .limit(50)
        .toArray();
      for (const row of expired)
        await mutate(row.ownerId, (state) => {
          state.jobs = state.jobs.filter(
            (job) =>
              active(job) || Date.parse(job.view.createdAt) > now().getTime() - 30 * 86400000,
          );
        });
      const rows = await deps
        .collection()
        .find({
          activeJobId: { $exists: true },
          $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now() } }],
        })
        .limit(50)
        .toArray();
      await Promise.allSettled(rows.slice(0, 2).map((row) => execute(row.ownerId)));
    } finally {
      ticking = false;
    }
  };
  const wake = (owner: string) => {
    void execute(owner).catch(() => undefined);
  };
  return {
    async settings(owner: string): Promise<MailResearchSettings> {
      const list = await profiles(owner);
      const model = await deps.adapter.availability(owner);
      const { state } = await read(owner);
      return {
        available: list.length > 0 && model.available,
        modelLabel: model.modelLabel,
        reason: !list.length ? 'Es ist kein erlaubtes Rechercheprofil verfügbar.' : model.reason,
        consentVersion: state.consentVersion,
        profiles: list,
        skills: state.skills,
      };
    },
    async saveSkill(owner: string, id: string, input: unknown): Promise<MailResearchSkill> {
      skillId.parse(id);
      const parsed = researchSkillSchema.parse(input);
      const list = await profiles(owner);
      if (parsed.sources.some((source) => !list.some((p) => p.kind === source))) throw denied();
      await deps.adapter.audit(owner, 'research_skill_saved', id);
      const { expectedRevision, consentVersion: _consent, ...content } = parsed;
      const skill = { id, ...content, revision: digest([id, content, randomUUID()]) };
      return mutate(owner, (state) => {
        const old = state.skills.find((s) => s.id === id);
        if ((old?.revision ?? '') !== expectedRevision)
          throw new MailAssistantError('Der Recherche-Skill wurde geändert. Bitte neu laden.');
        if (!old && state.skills.length >= 12)
          throw new MailAssistantError(
            'Es sind höchstens zwölf persönliche Recherche-Skills möglich.',
          );
        state.skills = [...state.skills.filter((s) => s.id !== id), skill];
        state.consentVersion = MAIL_RESEARCH_CONSENT_VERSION;
        return skill;
      });
    },
    async customers(owner: string, selectedProfile: unknown, search: unknown) {
      const id = profileId.parse(selectedProfile);
      const term = literal.parse(search);
      const allowed = await profiles(owner);
      if (
        (await read(owner)).state.consentVersion !== MAIL_RESEARCH_CONSENT_VERSION ||
        !allowed.some((p) => p.id === id)
      )
        throw denied();
      return deps.mcp.searchCustomers(owner, id, term, async () => {
        if (!(await profiles(owner)).some((p) => p.id === id)) throw denied();
      });
    },
    async enqueue(owner: string, id: string, input: unknown): Promise<MailResearchJob> {
      z.string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(id);
      const parsed = researchRunSchema.parse(input);
      const allowed = await profiles(owner);
      const requestHash = digest([id, parsed]);
      const { state } = await read(owner);
      const previous = state.jobs.find((j) => j.view.id === parsed.requestId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw denied();
        await guardJob(owner, previous);
        return previous.view;
      }
      const skill = state.skills.find(
        (s) => s.id === parsed.skillId && s.revision === parsed.skillRevision,
      );
      if (!skill || state.consentVersion !== MAIL_RESEARCH_CONSENT_VERSION) throw denied();
      const chosen = parsed.selections.map((selection) =>
        allowed.find((p) => p.id === selection.profileId),
      );
      if (
        chosen.some((p) => !p) ||
        new Set(chosen.map((p) => p!.kind)).size !== chosen.length ||
        chosen.length !== skill.sources.length ||
        chosen.some((p) => !skill.sources.includes(p!.kind))
      )
        throw denied();
      const initial = await snapshot(owner, id, parsed.revision);
      const guard = async () => {
        await snapshot(owner, id, parsed.revision);
      };
      const graph = await deps.adapter.graph(owner, guard);
      const mail = await graph.message(initial.result.messageId);
      if (
        mail.id !== initial.result.messageId ||
        mail.isDraft ||
        !mail.changeKey ||
        mail.bodyTruncated
      )
        throw denied();
      const view: MailResearchJob = {
        id: parsed.requestId,
        resultId: id,
        revision: parsed.revision,
        status: 'queued',
        createdAt: now().toISOString(),
        skill: { id: skill.id, revision: skill.revision, name: skill.name },
        sources: chosen.map((p) => ({ profileId: p!.id, kind: p!.kind, status: 'pending' })),
        evidence: [],
        warnings: [],
      };
      const job: StoredJob = {
        view,
        input: parsed,
        requestHash,
        skill,
        generation: initial.connection.generation!,
        mailbox: initial.connection.mailbox!,
        mailSettingsRevision: initial.settings.revision,
        modelFingerprint: initial.model.modelFingerprint!,
        sourceId: mail.id,
        changeKey: mail.changeKey,
      };
      await deps.adapter.audit(owner, 'research_requested', view.id);
      const result = await mutate(owner, (latest) => {
        const same = latest.jobs.find((j) => j.view.id === view.id);
        if (same) {
          if (same.requestHash !== requestHash) throw denied();
          return same.view;
        }
        if (latest.jobs.some(active)) throw busy();
        if (!latest.skills.some((s) => s.id === skill.id && s.revision === skill.revision))
          throw denied();
        latest.jobs = [
          ...latest.jobs
            .filter((j) => Date.parse(j.view.createdAt) > now().getTime() - 30 * 86400000)
            .slice(-19),
          job,
        ];
        return view;
      });
      wake(owner);
      return result;
    },
    async jobs(owner: string): Promise<MailResearchJob[]> {
      await profiles(owner);
      const { state } = await read(owner);
      const views: MailResearchJob[] = [];
      for (const job of state.jobs) {
        try {
          await guardJob(owner, job);
          views.push(job.view);
        } catch {
          views.push({
            ...job.view,
            status: job.view.status === 'cancelled' ? 'cancelled' : 'failed',
            sources: [],
            evidence: [],
            answer: undefined,
            warnings: [],
            error:
              'Diese Recherche ist unter den aktuellen Rechten oder Einstellungen nicht mehr verfügbar.',
          });
        }
      }
      wake(owner);
      return views.reverse();
    },
    async job(owner: string, id: string): Promise<MailResearchJob> {
      z.string().uuid().parse(id);
      const { state } = await read(owner);
      const job = state.jobs.find((j) => j.view.id === id);
      if (!job) throw denied();
      await guardJob(owner, job);
      wake(owner);
      return job.view;
    },
    async cancel(owner: string, id: string): Promise<MailResearchJob> {
      z.string().uuid().parse(id);
      await deps.adapter.authorize(owner);
      const { state: current } = await read(owner);
      const selected = current.jobs.find((j) => j.view.id === id);
      if (!selected) throw denied();
      if (!active(selected)) {
        await guardJob(owner, selected);
        return selected.view;
      }
      await deps.adapter.audit(owner, 'research_cancelled', id);
      return mutate(owner, (state) => {
        const job = state.jobs.find((j) => j.view.id === id);
        if (!job) throw denied();
        if (active(job)) {
          job.view.status = 'cancelled';
          job.view.completedAt = now().toISOString();
          job.view.evidence = [];
          job.view.sources = job.view.sources.map((source) => ({
            profileId: source.profileId,
            kind: source.kind,
            status: 'unavailable',
          }));
          delete job.view.answer;
        }
        // Completion may race cancellation; never return unchecked private evidence here.
        return { ...job.view, sources: [], evidence: [], answer: undefined, warnings: [] };
      });
    },
    start() {
      if (!timer) {
        timer = setInterval(() => {
          void tick().catch(() => undefined);
        }, 15000);
        timer.unref();
        void tick().catch(() => undefined);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
