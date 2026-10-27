import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { MailFetch } from './types';
import { MailAssistantError } from './engine';

export const followupProfile: z.ZodEnum<['odoo-administrator', 'odoo-admin', 'odoo-technik']> =
  z.enum(['odoo-administrator', 'odoo-admin', 'odoo-technik']);
export type FollowupProfile = z.infer<typeof followupProfile>;
export type OdooRecord = Record<string, unknown> & { id: number };
export interface FollowupOdoo {
  search(
    model: 'res.users' | 'res.partner' | 'project.project' | 'project.task',
    domain: unknown[],
    fields: string[],
    limit: number,
  ): Promise<OdooRecord[]>;
  get(model: 'project.project' | 'project.task', id: number, fields: string[]): Promise<OdooRecord>;
  writeCapability(): Promise<{ available: boolean; reason?: string }>;
  create(input: {
    name: string;
    body: string;
    projectId?: number;
    assigneeId: number;
    customerId?: number;
    operationKey: string;
  }): Promise<number>;
  note(id: number, body: string, operationKey: string): Promise<void>;
  close(): Promise<void>;
}
export interface FollowupIdentity {
  id: string;
  role: string;
  email: string;
  profiles: FollowupProfile[];
}
const profiles = followupProfile.options;
const toolNames = ['search_records', 'get_record', 'list_models'];
const safeTools = [
  'eucowork_mail_followup_capabilities',
  'eucowork_mail_followup_create',
  'eucowork_mail_followup_append',
];
export const followupWriteUnavailable =
  'Die sichere Odoo-Aufgabenablage ist noch nicht freigegeben. Die vorhandene Odoo-Brücke kann automatische Kundenmails nicht technisch ausschliessen. Vorschau und Einstellungen sind verfügbar; in Odoo wird nichts verändert.';
const failure = () =>
  new MailAssistantError(
    'Das freigegebene Odoo-Profil oder die benötigten Aufgabenrechte sind nicht verfügbar.',
  );
const row = z.object({ id: z.number().int().positive() }).passthrough();

export interface FollowupMcp {
  profiles(identity: FollowupIdentity): Promise<{ id: FollowupProfile; label: string }[]>;
  open(identity: FollowupIdentity, profile: string): Promise<FollowupOdoo>;
}

/** Fixed internal profiles preserve the existing gateway policy and Odoo ACL boundary. */
export function createFollowupMcp(
  request: MailFetch = fetch,
  refreshIdentity?: (owner: string) => Promise<FollowupIdentity>,
): FollowupMcp {
  const fresh = async (identity: FollowupIdentity) => {
    const current = refreshIdentity ? await refreshIdentity(identity.id) : identity;
    if (current.id !== identity.id) throw failure();
    return current;
  };
  const headers = (identity: FollowupIdentity) => ({
    'X-EUCowork-User-Id': identity.id,
    'X-EUCowork-User-Role': identity.role,
    'X-EUCowork-User-Email': identity.email,
  });
  const allowed = async (identity: FollowupIdentity, profile: FollowupProfile) => {
    try {
      identity = await fresh(identity);
      if (!identity.profiles.includes(profile)) return false;
      const response = await request(`http://mcp-gateway:3020/${profile}/_eucowork/access`, {
        headers: headers(identity),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      return response.ok && (await response.json()).allowed === true;
    } catch {
      return false;
    }
  };
  return {
    async profiles(identity: FollowupIdentity) {
      const access = await Promise.all(
        profiles.map(async (id) => ({ id, allowed: await allowed(identity, id) })),
      );
      return access.filter((item) => item.allowed).map(({ id }) => ({ id, label: id }));
    },
    async open(identity: FollowupIdentity, rawProfile: string): Promise<FollowupOdoo> {
      const profile = followupProfile.parse(rawProfile);
      if (!(await allowed(identity, profile))) throw failure();
      const client = new Client({ name: 'cw01-mail-followup', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://mcp-gateway:3020/${profile}`),
        {
          requestInit: { headers: headers(identity), redirect: 'error' },
          fetch: async (input, init) => {
            const target = new URL(input.toString());
            if (
              target.origin !== 'http://mcp-gateway:3020' ||
              target.pathname !== `/${profile}` ||
              target.username ||
              target.password ||
              target.search
            )
              throw failure();
            const currentIdentity = await fresh(identity);
            if (!currentIdentity.profiles.includes(profile)) throw failure();
            const currentHeaders = new Headers(init?.headers);
            for (const [name, value] of Object.entries(headers(currentIdentity)))
              currentHeaders.set(name, value);
            const response = await request(input, {
              ...init,
              headers: currentHeaders,
              redirect: 'error',
              signal: AbortSignal.any([
                AbortSignal.timeout(30000),
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
            if (!response.body) return response;
            let size = 0;
            const body = response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  size += chunk.byteLength;
                  if (size > 2 * 1024 * 1024) throw failure();
                  controller.enqueue(chunk);
                },
              }),
            );
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        },
      );
      try {
        await client.connect(transport, { timeout: 15000 });
        const list = await client.listTools({}, { timeout: 15000 });
        if (!toolNames.every((name) => list.tools.some((tool) => tool.name === name)))
          throw failure();
        const call = async (
          name: string,
          args: Record<string, unknown>,
        ): Promise<Record<string, unknown>> => {
          if (!(await allowed(identity, profile))) throw failure();
          const result = await client.callTool({ name, arguments: args }, undefined, {
            timeout: 30000,
          });
          if (result.isError) throw failure();
          if (result.structuredContent && typeof result.structuredContent === 'object')
            return result.structuredContent as Record<string, unknown>;
          const parts = z
            .array(z.object({ type: z.literal('text'), text: z.string().max(1500000) }))
            .safeParse(result.content);
          if (!parts.success || parts.data.length !== 1) throw failure();
          return z.record(z.unknown()).parse(JSON.parse(parts.data[0].text));
        };
        const capabilities = await call('list_models', {});
        const modelList = z
          .array(
            z
              .object({
                model: z.string(),
                operations: z
                  .object({ read: z.boolean(), write: z.boolean(), create: z.boolean() })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          )
          .parse(capabilities.models);
        if (
          capabilities.yolo_mode ||
          !['project.task', 'res.users', 'res.partner'].every((name) =>
            modelList.some((m) => m.model === name && m.operations?.read),
          )
        )
          throw failure();
        const writeCapability = async () => {
          if (
            !safeTools.every((name) => list.tools.some((tool) => tool.name === name)) ||
            !modelList.some(
              (model) =>
                model.model === 'project.task' &&
                model.operations?.write &&
                model.operations.create,
            )
          )
            return { available: false, reason: followupWriteUnavailable };
          try {
            const capability = await call('eucowork_mail_followup_capabilities', {});
            if (
              capability.protocol !== 'cw01-mail-followup/v1' ||
              capability.externalMailBlocked !== true ||
              capability.automationGuard !== true ||
              capability.profileAclPreserved !== true ||
              capability.atomicIdempotency !== true
            )
              return { available: false, reason: followupWriteUnavailable };
            return { available: true };
          } catch {
            return { available: false, reason: followupWriteUnavailable };
          }
        };
        const requireSafeWrite = async () => {
          const capability = await writeCapability();
          if (!capability.available) throw new MailAssistantError(followupWriteUnavailable);
        };
        return {
          writeCapability,
          async search(model, domain, fields, limit) {
            const output = await call('search_records', {
              model,
              domain,
              fields,
              limit,
              offset: 0,
              order: 'id desc',
            });
            return z.array(row).max(120).parse(output.records);
          },
          async get(model, id, fields) {
            const output = await call('get_record', { model, record_id: id, fields });
            const record = row.parse(output.record);
            if (record.id !== id) throw failure();
            return record;
          },
          async create(input) {
            await requireSafeWrite();
            const output = await call('eucowork_mail_followup_create', {
              name: input.name,
              body_text: input.body,
              project_id: input.projectId ?? false,
              assignee_user_id: input.assigneeId,
              customer_id: input.customerId ?? false,
              operation_key: input.operationKey,
            });
            if (output.success !== true) throw failure();
            return row.parse(output.record).id;
          },
          async note(id, body, operationKey) {
            await requireSafeWrite();
            const output = await call('eucowork_mail_followup_append', {
              task_id: id,
              body_text: body,
              operation_key: operationKey,
            });
            if (output.success !== true || !Number.isSafeInteger(output.message_id))
              throw failure();
          },
          close: async () => {
            await client.close().catch(() => undefined);
          },
        };
      } catch {
        await client.close().catch(() => undefined);
        throw failure();
      }
    },
  };
}
