import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Collection } from 'mongodb';
import type { MailCodec } from './privateData';
import type { MailAssistantEngine, MailRuntimeAdapter, MailStore } from './types';
import type { FollowupIdentity, FollowupOdoo, FollowupProfile, OdooRecord } from './followupMcp';
import { MailAssistantError, resultRevision } from './engine';
import { MAIL_CONSENT_VERSION } from './types';
import { followupProfile, followupWriteUnavailable } from './followupMcp';

export interface FollowupSettings {
  profile: FollowupProfile;
  mode: 'project' | 'todo';
  projectId?: number;
  projectName?: string;
  userId: number;
  userName: string;
}
interface Candidate {
  id: number;
  name: string;
  customer?: string;
}
interface Receipt {
  status: 'completed' | 'uncertain';
  taskId?: number;
  taskUrl?: string;
  action?: 'created' | 'appended';
}
interface Preview {
  token: string;
  ownerId: string;
  mailbox: string;
  generation: string;
  mailSettingsRevision: number;
  settingsHash: string;
  settings: FollowupSettings;
  resultId: string;
  resultRevision: string;
  operationId: string;
  title: string;
  body: string;
  targetLabel: string;
  candidates: Candidate[];
  taskFingerprints: Record<string, string>;
  customerId?: number;
  expiresAt: string;
}
export interface FollowupRow {
  _id: string;
  ownerId: string;
  kind: 'settings' | 'preview' | 'operation';
  encrypted: string;
  state?: 'pending' | 'completed' | 'uncertain';
  externalStarted?: boolean;
  profile?: FollowupProfile;
  updatedAt: Date;
  expiresAt?: Date;
}
export const followupSettingsSchema: z.ZodType<{
  profile: FollowupProfile;
  mode: 'project' | 'todo';
  projectId?: number;
}> = z
  .object({
    profile: followupProfile,
    mode: z.enum(['project', 'todo']),
    projectId: z.number().int().positive().optional(),
  })
  .strict();
export const followupPrepareSchema: z.ZodType<{ revision: string }> = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const followupCommitSchema: z.ZodType<{ token: string; taskId?: number }> = z
  .object({ token: z.string().uuid(), taskId: z.number().int().positive().optional() })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message: string): never {
  throw new MailAssistantError(message);
}
const projectFields = ['id', 'name', 'privacy_visibility', 'active'];
const taskFields = [
  'id',
  'name',
  'project_id',
  'user_ids',
  'partner_id',
  'state',
  'active',
  'description',
];
const relationId = (value: unknown): number | undefined =>
  Array.isArray(value) && Number.isSafeInteger(value[0]) ? (value[0] as number) : undefined;
const text = (value: unknown, max = 300) =>
  typeof value === 'string'
    ? [...value]
        .filter(
          (character) => character.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(character),
        )
        .join('')
        .slice(0, max)
    : '';
const normalizedTopic = (value: string) =>
  value
    .toLocaleLowerCase('de-CH')
    .replace(/^(?:(?:re|aw|fw|wg|fwd)\s*:\s*)+/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const taskUrl = (id: number) =>
  `https://erp.rzcloud.ch/web#id=${id}&model=project.task&view_type=form`;

export interface MailFollowupService {
  settings(owner: string): Promise<{
    profiles: { id: FollowupProfile; label: string }[];
    settings: FollowupSettings | null;
  }>;
  saveSettings(owner: string, input: unknown): Promise<FollowupSettings>;
  projects(
    owner: string,
    profile: unknown,
    search: unknown,
  ): Promise<{ id: number; name: string }[]>;
  prepare(
    owner: string,
    id: string,
    input: unknown,
  ): Promise<
    | (Pick<Preview, 'token' | 'title' | 'body' | 'targetLabel' | 'candidates' | 'expiresAt'> & {
        suggestedTaskId?: number;
        writeAvailable: boolean;
        writeReason?: string;
      })
    | { existing: Receipt }
  >;
  commit(owner: string, input: unknown): Promise<Receipt>;
  clearPreviews(owner: string): Promise<void>;
}

/** User-selected, fixed Odoo operations. Mail text never selects a model, tool or recipient. */
export function createMailFollowup(deps: {
  collection: () => Collection<FollowupRow>;
  codec: MailCodec;
  store: MailStore;
  engine: MailAssistantEngine;
  adapter: MailRuntimeAdapter;
  identity: (owner: string) => Promise<FollowupIdentity>;
  profiles: (identity: FollowupIdentity) => Promise<{ id: FollowupProfile; label: string }[]>;
  open: (identity: FollowupIdentity, profile: FollowupProfile) => Promise<FollowupOdoo>;
  now?: () => Date;
}): MailFollowupService {
  const now = deps.now ?? (() => new Date());
  let indexes: Promise<unknown> | undefined;
  const col = async () => {
    const collection = deps.collection();
    indexes ??= Promise.all([
      collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      collection.createIndex({ ownerId: 1, kind: 1 }),
    ]).catch((error) => {
      indexes = undefined;
      throw error;
    });
    await indexes;
    return collection;
  };
  const readSettings = async (owner: string): Promise<FollowupSettings | null> => {
    const saved = await (
      await col()
    ).findOne({ _id: `settings:${owner}`, ownerId: owner, kind: 'settings' });
    return saved ? deps.codec.open(owner, 'followup-settings', saved.encrypted) : null;
  };
  const withOdoo = async <T>(
    owner: string,
    profile: FollowupProfile,
    action: (odoo: FollowupOdoo, identity: FollowupIdentity) => Promise<T>,
  ) => {
    const identity = await deps.identity(owner);
    const odoo = await deps.open(identity, profile);
    try {
      return await action(odoo, identity);
    } finally {
      await odoo.close();
    }
  };
  const verifyTarget = async (
    odoo: FollowupOdoo,
    identity: FollowupIdentity,
    input: z.infer<typeof followupSettingsSchema>,
  ): Promise<FollowupSettings> => {
    const email = identity.email.toLowerCase();
    const users = await odoo.search(
      'res.users',
      [
        ['active', '=', true],
        ['share', '=', false],
        '|',
        ['login', '=ilike', email],
        ['email', '=ilike', email],
      ],
      ['id', 'name', 'email', 'login', 'share', 'active'],
      3,
    );
    const matched = users.filter(
      (user) =>
        user.share === false &&
        user.active === true &&
        [user.email, user.login].some(
          (value) => typeof value === 'string' && value.toLowerCase() === email,
        ),
    );
    if (matched.length !== 1)
      fail(
        'Dein bestätigtes Cowork-Konto ist keinem eindeutigen internen Odoo-Benutzer zugeordnet.',
      );
    const base: FollowupSettings = {
      profile: input.profile,
      mode: input.mode,
      userId: matched[0].id,
      userName: text(matched[0].name),
    };
    if (input.mode === 'todo') {
      if (input.projectId) fail('Persönliche To-dos verwenden kein Projekt.');
      return base;
    }
    if (!input.projectId) fail('Bitte wähle ein vorhandenes internes Projekt.');
    const project = await odoo.get('project.project', input.projectId!, projectFields);
    if (
      project.active !== true ||
      !['followers', 'employees'].includes(String(project.privacy_visibility))
    )
      fail(
        'Dieses Projekt ist extern freigegeben oder nicht sicher als internes Ziel verwendbar. Bitte wähle ein internes Projekt.',
      );
    return { ...base, projectId: project.id, projectName: text(project.name) };
  };
  const binding = async (owner: string, id: string, revision: string) => {
    await deps.identity(owner);
    const [job, connection, result] = await Promise.all([
      deps.store.read(owner),
      deps.adapter.connection(owner),
      deps.store.result(owner, id),
    ]);
    if (
      !job ||
      job.settings.consentVersion !== MAIL_CONSENT_VERSION ||
      !connection.connected ||
      !connection.mailbox ||
      !connection.generation
    )
      fail('Bitte verbinde dein eigenes Postfach und bestätige die persönliche Verarbeitung.');
    if (
      !result ||
      resultRevision(result) !== revision ||
      result.moveStatus ||
      result.operationPending ||
      result.editPending
    )
      fail(
        'Die Mail wurde verändert oder wird gerade bearbeitet. Bitte aktualisiere die Übersicht.',
      );
    return {
      mailbox: connection.mailbox!,
      generation: connection.generation!,
      mailSettingsRevision: job!.revision,
      operationId: `operation:${hash([owner, connection.mailbox!.toLowerCase(), result!.messageId])}`,
    };
  };
  const ensureBinding = async (owner: string, preview: Preview) => {
    const current = await binding(owner, preview.resultId, preview.resultRevision);
    if (
      current.generation !== preview.generation ||
      current.mailbox !== preview.mailbox ||
      current.mailSettingsRevision !== preview.mailSettingsRevision ||
      current.operationId !== preview.operationId ||
      hash(await readSettings(owner)) !== preview.settingsHash
    )
      fail(
        'Verbindung, Mail oder Aufgabenziel wurden verändert. Bitte den Vorschlag erneut vorbereiten.',
      );
  };
  const receipt = (owner: string, saved: FollowupRow): Receipt => {
    if (saved.state !== 'completed') return { status: 'uncertain' };
    return deps.codec.open(owner, 'followup-receipt', saved.encrypted);
  };
  const existingReceipt = async (owner: string, saved: FollowupRow): Promise<Receipt> => {
    if (!saved.profile) fail('Das gespeicherte Odoo-Profil ist nicht verfügbar.');
    return withOdoo(owner, saved.profile, async () => receipt(owner, saved));
  };
  const visibleTask = (task: OdooRecord, target: FollowupSettings) =>
    task.active === true &&
    !['1_done', '1_canceled'].includes(String(task.state)) &&
    (target.mode === 'project'
      ? relationId(task.project_id) === target.projectId
      : task.project_id === false &&
        Array.isArray(task.user_ids) &&
        task.user_ids.includes(target.userId));

  return {
    async settings(owner: string) {
      const identity = await deps.identity(owner);
      return { profiles: await deps.profiles(identity), settings: await readSettings(owner) };
    },
    async saveSettings(owner: string, input: unknown) {
      const parsed = followupSettingsSchema.parse(input);
      const target = await withOdoo(owner, parsed.profile, (odoo, identity) =>
        verifyTarget(odoo, identity, parsed),
      );
      await deps.adapter.audit(owner, 'followup.settings');
      await (
        await col()
      ).updateOne(
        { _id: `settings:${owner}`, ownerId: owner },
        {
          $set: {
            kind: 'settings',
            encrypted: deps.codec.seal(owner, 'followup-settings', target),
            updatedAt: now(),
          },
        },
        { upsert: true },
      );
      try {
        await deps.identity(owner);
      } catch (error) {
        await (
          await col()
        ).deleteMany({ _id: `settings:${owner}`, ownerId: owner, kind: 'settings' });
        throw error;
      }
      return target;
    },
    async projects(owner: string, profile: unknown, search: unknown) {
      const parsedProfile = followupProfile.parse(profile);
      const query = z
        .string()
        .max(100)
        .parse(search ?? '')
        .trim();
      return withOdoo(owner, parsedProfile, async (odoo) => {
        const rows = await odoo.search(
          'project.project',
          [
            ['active', '=', true],
            ['privacy_visibility', 'in', ['followers', 'employees']],
            ...(query ? [['name', 'ilike', query]] : []),
          ],
          projectFields,
          50,
        );
        return rows
          .filter(
            (p) =>
              p.active === true &&
              ['followers', 'employees'].includes(String(p.privacy_visibility)),
          )
          .map((p) => ({ id: p.id, name: text(p.name) }));
      });
    },
    async prepare(owner: string, id: string, input: unknown) {
      const parsed = followupPrepareSchema.parse(input);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail('Mail-Vorgang nicht gefunden.');
      const target = await readSettings(owner);
      if (!target) fail('Bitte lege zuerst dein persönliches Aufgabenziel fest.');
      const bound = await binding(owner, id, parsed.revision);
      const previous = await (
        await col()
      ).findOne({ _id: bound.operationId, ownerId: owner, kind: 'operation' });
      if (previous) return { existing: await existingReceipt(owner, previous) };
      return withOdoo(owner, target.profile, async (odoo, identity) => {
        const verified = await verifyTarget(odoo, identity, {
          profile: target.profile,
          mode: target.mode,
          ...(target.projectId ? { projectId: target.projectId } : {}),
        });
        if (hash(verified) !== hash(target))
          fail('Das Odoo-Ziel wurde verändert. Bitte speichere deine Einstellungen erneut.');
        const content = await deps.engine.content(owner, id);
        const title = text(content.message.subject, 200) || 'Nachbearbeitung einer Mail';
        const sender = text(content.message.sender, 320);
        const address = sender.match(/<?([^<>\s]+@[^<>\s]+)>?/)?.[1]?.toLowerCase();
        const partners = address
          ? await odoo.search(
              'res.partner',
              [['email', '=ilike', address]],
              ['id', 'email', 'commercial_partner_id'],
              3,
            )
          : [];
        const exactPartners = partners.filter(
          (partner) => typeof partner.email === 'string' && partner.email.toLowerCase() === address,
        );
        const customerIds = [
          ...new Set(
            exactPartners.map((partner) => relationId(partner.commercial_partner_id) ?? partner.id),
          ),
        ];
        const customerId = customerIds.length === 1 ? customerIds[0] : undefined;
        const matchingPartnerIds = customerId
          ? [...new Set([customerId, ...exactPartners.map((partner) => partner.id)])]
          : [];
        const topic = normalizedTopic(title);
        const words = topic
          .split(' ')
          .filter((word) => word.length >= 4)
          .slice(0, 8);
        const domain: unknown[] = [
          ['active', '=', true],
          ['state', 'not in', ['1_done', '1_canceled']],
          ...(target.mode === 'project'
            ? [['project_id', '=', target.projectId]]
            : [
                ['project_id', '=', false],
                ['user_ids', 'in', [target.userId]],
              ]),
        ];
        if (customerId) domain.push(['partner_id', 'in', matchingPartnerIds]);
        if (words.length)
          domain.push(
            ...Array(Math.max(0, words.length - 1)).fill('|'),
            ...words.map((word) => ['name', 'ilike', word]),
          );
        const tasks = words.length
          ? await odoo.search('project.task', domain, taskFields, 100)
          : [];
        const matchedTasks = tasks
          .filter((task) => {
            if (!visibleTask(task, target)) return false;
            const taskTopic = normalizedTopic(text(task.name));
            const overlap = words.filter((word) => taskTopic.includes(word)).length;
            const sameCustomer =
              (customerId && matchingPartnerIds.includes(relationId(task.partner_id) ?? -1)) ||
              (address && text(task.description, 20000).toLowerCase().includes(address));
            return !!sameCustomer && (taskTopic === topic || overlap >= Math.min(2, words.length));
          })
          .slice(0, 8);
        const candidates = matchedTasks.map((task) => ({
          id: task.id,
          name: text(task.name),
          ...(Array.isArray(task.partner_id) ? { customer: text(task.partner_id[1]) } : {}),
        }));
        const body = `Mail zur späteren Bearbeitung\nVon: ${sender}\nEmpfangen: ${text(content.message.receivedAt)}\nBetreff: ${title}\n\n${text(content.message.body, 20000)}${content.message.bodyTruncated || content.message.body.length > 20000 ? '\n\n[Mailtext gekürzt; vollständige Mail im eigenen Postfach.]' : ''}`;
        const token = randomUUID();
        const expiresAt = new Date(now().getTime() + 10 * 60000).toISOString();
        const preview: Preview = {
          token,
          ownerId: owner,
          ...bound,
          settings: target,
          settingsHash: hash(target),
          resultId: id,
          resultRevision: parsed.revision,
          title,
          body,
          targetLabel:
            target.mode === 'todo'
              ? `Persönliche To-dos · ${target.userName}`
              : target.projectName!,
          candidates,
          taskFingerprints: Object.fromEntries(
            matchedTasks.map((task) => [String(task.id), hash(task)]),
          ),
          ...(customerId ? { customerId } : {}),
          expiresAt,
        };
        await ensureBinding(owner, preview);
        await deps.adapter.audit(owner, 'followup.preview', id);
        await (
          await col()
        ).insertOne({
          _id: `preview:${token}`,
          ownerId: owner,
          kind: 'preview',
          encrypted: deps.codec.seal(owner, 'followup-preview', preview),
          updatedAt: now(),
          expiresAt: new Date(expiresAt),
        });
        try {
          await ensureBinding(owner, preview);
        } catch (error) {
          await (
            await col()
          ).deleteMany({ _id: `preview:${token}`, ownerId: owner, kind: 'preview' });
          throw error;
        }
        const writeCapability = await odoo.writeCapability();
        return {
          writeAvailable: writeCapability.available,
          ...(!writeCapability.available
            ? { writeReason: writeCapability.reason ?? followupWriteUnavailable }
            : {}),
          token,
          title,
          body,
          targetLabel: preview.targetLabel,
          candidates,
          ...(candidates.length === 1 ? { suggestedTaskId: candidates[0].id } : {}),
          expiresAt,
        };
      });
    },
    async commit(owner: string, input: unknown): Promise<Receipt> {
      const parsed = followupCommitSchema.parse(input);
      await deps.identity(owner);
      const collection = await col();
      const saved = await collection.findOne({
        _id: `preview:${parsed.token}`,
        ownerId: owner,
        kind: 'preview',
      });
      if (!saved || !saved.expiresAt || saved.expiresAt <= now())
        fail('Der Vorschlag ist abgelaufen. Bitte bereite ihn erneut vor.');
      const preview = deps.codec.open<Preview>(owner, 'followup-preview', saved!.encrypted);
      if (parsed.taskId && !preview.candidates.some((candidate) => candidate.id === parsed.taskId))
        fail('Diese Aufgabe war nicht Teil des geprüften Vorschlags.');
      const previous = await collection.findOne({
        _id: preview.operationId,
        ownerId: owner,
        kind: 'operation',
      });
      if (previous) return existingReceipt(owner, previous);
      await ensureBinding(owner, preview);
      return withOdoo(owner, preview.settings.profile, async (odoo, identity) => {
        const target = await verifyTarget(odoo, identity, {
          profile: preview.settings.profile,
          mode: preview.settings.mode,
          ...(preview.settings.projectId ? { projectId: preview.settings.projectId } : {}),
        });
        if (hash(target) !== preview.settingsHash)
          fail('Das Odoo-Ziel wurde verändert. Bitte den Vorschlag erneut prüfen.');
        if (parsed.taskId) {
          const currentTask = await odoo.get('project.task', parsed.taskId, taskFields);
          if (
            !visibleTask(currentTask, target) ||
            hash(currentTask) !== preview.taskFingerprints[String(parsed.taskId)]
          )
            fail('Die gewählte Aufgabe wurde verändert. Bitte prüfe den Vorschlag erneut.');
        }
        await ensureBinding(owner, preview);
        const capability = await odoo.writeCapability();
        if (!capability.available) fail(capability.reason ?? followupWriteUnavailable);
        await deps.adapter.audit(
          owner,
          parsed.taskId ? 'followup.append' : 'followup.create',
          preview.resultId,
        );
        try {
          await collection.insertOne({
            _id: preview.operationId,
            ownerId: owner,
            kind: 'operation',
            state: 'pending',
            profile: target.profile,
            externalStarted: false,
            encrypted: deps.codec.seal(owner, 'followup-operation', {
              resultId: preview.resultId,
              taskId: parsed.taskId,
              profile: target.profile,
            }),
            updatedAt: now(),
          });
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          const duplicate = await collection.findOne({
            _id: preview.operationId,
            ownerId: owner,
            kind: 'operation',
          });
          if (!duplicate) throw error;
          return existingReceipt(owner, duplicate);
        }
        try {
          await ensureBinding(owner, preview);
          const started = await collection.updateOne(
            { _id: preview.operationId, ownerId: owner, state: 'pending', externalStarted: false },
            { $set: { externalStarted: true, updatedAt: now() } },
          );
          if (started.matchedCount !== 1) fail('Die Aufgabenablage wurde unterbrochen.');
          let taskId = parsed.taskId;
          if (taskId) await odoo.note(taskId, preview.body, preview.operationId);
          else
            taskId = await odoo.create({
              name: preview.title,
              body: preview.body,
              projectId: target.projectId,
              assigneeId: target.userId,
              customerId: preview.customerId,
              operationKey: preview.operationId,
            });
          const result: Receipt = {
            status: 'completed',
            taskId,
            taskUrl: taskUrl(taskId),
            action: parsed.taskId ? 'appended' : 'created',
          };
          await collection.updateOne(
            { _id: preview.operationId, ownerId: owner, state: 'pending' },
            {
              $set: {
                state: 'completed',
                encrypted: deps.codec.seal(owner, 'followup-receipt', result),
                updatedAt: now(),
              },
            },
          );
          await deps.identity(owner);
          return result;
        } catch {
          await collection.updateOne(
            { _id: preview.operationId, ownerId: owner, state: 'pending' },
            { $set: { state: 'uncertain', updatedAt: now() } },
          );
          return { status: 'uncertain' };
        }
      });
    },
    async clearPreviews(owner: string) {
      await (await col()).deleteMany({ ownerId: owner, kind: 'preview' });
    },
  };
}
