import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import type { GenericTool } from '@librechat/agents';
import type { TMessage } from 'librechat-data-provider';
import type { SafeWorkScope, SafeWriteDependencies } from './safeWork';
import {
  safeWorkDependencies,
  SAFE_WORK_RECORDS,
  hasUncertainSafeWork,
  isSafeWorkEnabled,
} from './safeWork';

export const WORK_OUTPUTS = 'eucowork_work_outputs';
export const WORK_CUSTOMERS = 'eucowork_work_customers';
const PAGE = 12000;
interface StoredOutput {
  _id: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  source: string;
  contentEnc: string;
  length: number;
  visited: Array<{ start: number; end: number }>;
  upstreamIncomplete: boolean;
  taskKey: string;
  requiresCoverage: boolean;
  expiresAt: Date | null;
}
interface Checkpoint {
  _id: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  customerId: number;
  status: 'active' | 'completed' | 'blocked';
  summaryEnc: string;
  records: Array<{ model: string; id: number }>;
  references: string[];
  updatedAt: Date;
  expiresAt: Date | null;
}
const initialized = new WeakMap<object, Promise<unknown>>();
async function ready(deps: SafeWriteDependencies): Promise<void> {
  let pending = initialized.get(deps.db);
  if (!pending) {
    pending = Promise.all(
      [WORK_OUTPUTS, WORK_CUSTOMERS].map((name) =>
        Promise.all([
          deps.db.collection(name).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
          deps.db.collection(name).createIndex({ userId: 1, conversationId: 1 }),
        ]),
      ),
    ).catch((error) => {
      initialized.delete(deps.db);
      throw error;
    });
    initialized.set(deps.db, pending);
  }
  await pending;
}
async function conversationExpiry(
  scope: SafeWorkScope,
  deps: SafeWriteDependencies,
): Promise<Date | null> {
  await ready(deps);
  const conversation = await deps.db
    .collection('conversations')
    .findOne(
      { user: scope.userId, conversationId: scope.conversationId },
      { projection: { expiredAt: 1 } },
    );
  if (
    !conversation ||
    (conversation.expiredAt && +new Date(conversation.expiredAt) <= Date.now())
  ) {
    throw new Error(
      'Der eigene Chat ist nicht mehr verfügbar oder seine Aufbewahrungsfrist ist beendet.',
    );
  }
  return conversation.expiredAt ? new Date(conversation.expiredAt) : null;
}
const owner = (scope: SafeWorkScope) => ({
  userId: scope.userId,
  tenantId: scope.tenantId || 'cw01',
  conversationId: scope.conversationId,
});
const key = (deps: SafeWriteDependencies, scope: SafeWorkScope, source: string) =>
  createHmac('sha256', deps.secret)
    .update(JSON.stringify([owner(scope), source]))
    .digest('hex');
export function covered(ranges: StoredOutput['visited'], length: number): boolean {
  let end = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > end) return false;
    end = Math.max(end, range.end);
  }
  return end >= length;
}
export async function saveWorkOutput(
  scope: SafeWorkScope,
  source: string,
  content: string,
  deps: SafeWriteDependencies = safeWorkDependencies(),
  requiresCoverage: boolean = false,
): Promise<string> {
  if (content.length > 10_000_000)
    throw new Error(
      'Die Ausgabe überschreitet die sichere Ablagegrösse; bitte kleinere Datenbereiche abrufen.',
    );
  const expiresAt = await conversationExpiry(scope, deps);
  // The same query may return a new live state; never substitute an older snapshot.
  const id = key(
    deps,
    scope,
    source + ':' + createHmac('sha256', deps.secret).update(content).digest('hex'),
  );
  if (
    await deps.db
      .collection<StoredOutput>(WORK_OUTPUTS)
      .findOne({ _id: id, ...owner(scope) }, { projection: { _id: 1 } })
  )
    return id;
  await deps.db.collection<StoredOutput>(WORK_OUTPUTS).updateOne(
    { _id: id, ...owner(scope) },
    {
      $setOnInsert: {
        ...owner(scope),
        source: key(deps, scope, source),
        contentEnc: deps.encrypt(content),
        length: content.length,
        visited: [],
        taskKey: key(deps, scope, `task:${scope.taskId}`),
        requiresCoverage,
        upstreamIncomplete:
          /\[\s*(?:\.\.\.|truncated|gekürzt|abgeschnitten)|"truncated"\s*:\s*true/i.test(content),
        expiresAt,
      },
    },
    { upsert: true, writeConcern: { w: 'majority' } },
  );
  return id;
}
export async function readWorkOutput(
  scope: SafeWorkScope,
  reference: string,
  offset = 0,
  length: number = PAGE,
  deps: SafeWriteDependencies = safeWorkDependencies(),
): Promise<string> {
  if (
    !/^[a-f0-9]{64}$/.test(reference) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > PAGE
  )
    throw new Error('Ungültiger Abrufbereich.');
  const collection = deps.db.collection<StoredOutput>(WORK_OUTPUTS);
  await conversationExpiry(scope, deps);
  const stored = await collection.findOne({
    _id: reference,
    ...owner(scope),
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  if (!stored)
    throw new Error(
      'Diese Arbeitsdaten sind nicht verfügbar oder gehören nicht zu diesem eigenen Chat.',
    );
  if (offset > stored.length) throw new Error('Der Abrufbereich liegt ausserhalb der Ausgabe.');
  const original = deps.decrypt(stored.contentEnc);
  let end = Math.min(stored.length, offset + length);
  while (JSON.stringify(original.slice(offset, end)).length > 24000) {
    end = offset + Math.max(1, Math.floor((end - offset) / 2));
  }
  await collection.updateOne(
    { _id: reference, ...owner(scope) },
    { $addToSet: { visited: { start: offset, end } } },
  );
  return JSON.stringify({
    reference,
    source: stored.source,
    snapshot: true,
    offset,
    end,
    totalCharacters: stored.length,
    nextOffset: end < stored.length ? end : null,
    fullyRead:
      !stored.upstreamIncomplete &&
      covered([...stored.visited, { start: offset, end }], stored.length),
    upstreamIncomplete: stored.upstreamIncomplete,
    content: original.slice(offset, end),
    note: 'Gespeicherter Quellenstand. Vor Änderungen den aktuellen Datensatz frisch lesen.',
  });
}
/** Preserve complete external results before the graph's response-size truncation. */
export async function pageWorkOutput(
  scope: SafeWorkScope,
  source: string,
  result: [string, object[]],
  deps: SafeWriteDependencies = safeWorkDependencies(),
): Promise<[string, object[]]> {
  if (typeof result[0] !== 'string' || result[0].length <= PAGE) return result;
  const reference = await saveWorkOutput(
    scope,
    source,
    result[0],
    deps,
    !source.includes(':list_models:'),
  );
  return [await readWorkOutput(scope, reference, 0, PAGE, deps), result[1]];
}
export async function hasIncompleteWorkSources(
  scope: SafeWorkScope,
  deps: SafeWriteDependencies = safeWorkDependencies(),
): Promise<boolean> {
  const rows = await deps.db
    .collection<StoredOutput>(WORK_OUTPUTS)
    .find(
      {
        ...owner(scope),
        taskKey: key(deps, scope, `task:${scope.taskId}`),
        requiresCoverage: true,
      },
      { projection: { visited: 1, length: 1, upstreamIncomplete: 1 } },
    )
    .toArray();
  return rows.some((row) => row.upstreamIncomplete || !covered(row.visited, row.length));
}
export async function saveCustomerCheckpoint(
  scope: SafeWorkScope,
  input: {
    customerId: number;
    status: Checkpoint['status'];
    summary: string;
    records: Checkpoint['records'];
    references: string[];
  },
  deps: SafeWriteDependencies = safeWorkDependencies(),
): Promise<string> {
  const expiresAt = await conversationExpiry(scope, deps);
  if (input.status === 'completed') {
    if (await hasIncompleteWorkSources(scope, deps))
      throw new Error('Eine Quelle dieses Auftrags wurde noch nicht vollständig gelesen.');
    if (await hasUncertainSafeWork(scope, deps))
      throw new Error('Ungeklärte Änderungen verhindern einen bestätigten Kundenabschluss.');
    if (input.records.length) {
      const rows = await deps.db
        .collection(SAFE_WORK_RECORDS)
        .find(
          {
            ...owner(scope),
            $or: input.records.map((record) => ({ model: record.model, recordId: record.id })),
            state: 'verified',
          },
          { projection: { recordId: 1, model: 1 } },
        )
        .toArray();
      if (
        input.records.some(
          (record) => !rows.some((row) => row.recordId === record.id && row.model === record.model),
        )
      )
        throw new Error(
          'Nicht jede als geändert angegebene Zeile hat eine bestätigte Rücklesekontrolle.',
        );
    }
    for (const reference of input.references) {
      const row = await deps.db
        .collection<StoredOutput>(WORK_OUTPUTS)
        .findOne({ _id: reference, ...owner(scope) });
      if (!row || row.upstreamIncomplete || !covered(row.visited, row.length))
        throw new Error('Eine angegebene Quelle wurde noch nicht vollständig gelesen.');
    }
  }
  const id = key(deps, scope, `customer:${input.customerId}`);
  await deps.db.collection<Checkpoint>(WORK_CUSTOMERS).updateOne(
    { _id: id, ...owner(scope) },
    {
      $set: {
        ...owner(scope),
        customerId: input.customerId,
        status: input.status,
        summaryEnc: deps.encrypt(input.summary),
        records: input.records,
        references: input.references,
        updatedAt: new Date(),
        expiresAt,
      },
    },
    { upsert: true, writeConcern: { w: 'majority' } },
  );
  return JSON.stringify({
    checkpoint: id,
    customerId: input.customerId,
    status: input.status,
    verified: input.status === 'completed',
    summary: input.summary,
    verificationScope: 'listed_records_and_sources',
    note: 'Dieser Arbeitsstand erteilt keine neue Schreibfreigabe. Originalfreigaben und aktuelle Zustände bleiben massgeblich.',
  });
}
export function workTools(scope: SafeWorkScope, deps?: SafeWriteDependencies): GenericTool[] {
  return [
    tool(
      async ({ reference, offset, length }) =>
        readWorkOutput(scope, reference, offset, length, deps),
      {
        name: 'arbeitsdaten_lesen',
        description:
          'Read a complete stored tool-output snapshot from this owned chat in bounded character ranges. Follow nextOffset until fullyRead is true when the task requires complete source review. Does not query live Odoo or authorize writes.',
        schema: z.object({
          reference: z.string().regex(/^[a-f0-9]{64}$/),
          offset: z.number().int().min(0).default(0),
          length: z.number().int().min(1).max(PAGE).default(PAGE),
        }),
      },
    ),
    tool(
      async ({ customerId, status, summary, records, references }) =>
        saveCustomerCheckpoint(scope, { customerId, status, summary, records, references }, deps),
      {
        name: 'arbeitsstand_sichern',
        description:
          'Save a compact per-customer work checkpoint. List all changed record IDs and every paged source used. Completed status requires confirmed individual read-backs and complete reading of the supplied sources. Keep global user rules in their original messages; this checkpoint is not an approval.',
        schema: z.object({
          customerId: z.number().int().positive(),
          status: z.enum(['active', 'completed', 'blocked']),
          summary: z.string().min(1).max(6000),
          records: z
            .array(
              z.object({
                model: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
                id: z.number().int().positive(),
              }),
            )
            .max(1000)
            .default([]),
          references: z
            .array(z.string().regex(/^[a-f0-9]{64}$/))
            .max(500)
            .default([]),
        }),
      },
    ),
  ];
}
interface ToolPart {
  type?: string;
  tool_call?: { name?: string; id?: string; args?: string; output?: string };
}
const compactable =
  /^(?:get_record|search_records|aggregate_records|list_models|list_resource_templates)_mcp_odoo(?:-|$)/i;
/** Only completed customer boundaries compact old read outputs; user text and write receipts remain intact. */
export async function compactWorkHistory<
  T extends Pick<TMessage, 'messageId' | 'content' | 'isCreatedByUser'>,
>(messages: T[], scope: SafeWorkScope, deps?: SafeWriteDependencies): Promise<T[]> {
  if (!isSafeWorkEnabled()) return messages;
  let boundary = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].isCreatedByUser) continue;
    const parts = messages[i].content as ToolPart[] | undefined;
    for (const part of parts ?? []) {
      if (part.tool_call?.name !== 'arbeitsstand_sichern' || !part.tool_call.output) continue;
      try {
        const value = JSON.parse(part.tool_call.output) as {
          checkpoint?: string;
          verified?: boolean;
          status?: string;
        };
        if (!value.checkpoint || value.verified !== true || value.status !== 'completed') continue;
        const checkpoint = await (deps ?? safeWorkDependencies()).db
          .collection<Checkpoint>(WORK_CUSTOMERS)
          .findOne(
            { _id: value.checkpoint, ...owner(scope), status: 'completed' },
            { projection: { _id: 1 } },
          );
        if (checkpoint) boundary = i;
      } catch {
        /* Unconfirmed or edited message content cannot authorize compaction. */
      }
    }
  }
  if (boundary < 0) return messages;
  return Promise.all(
    messages.map(async (message, index) => {
      if (index >= boundary || message.isCreatedByUser || !message.content) return message;
      let changed = false;
      const content = await Promise.all(
        (message.content as ToolPart[]).map(async (part) => {
          const call = part.tool_call;
          if (
            !call?.name ||
            !compactable.test(call.name) ||
            typeof call.output !== 'string' ||
            call.output.length < 1200
          )
            return part;
          const reference = await saveWorkOutput(
            scope,
            `${message.messageId}:${call.id ?? call.name}`,
            call.output,
            deps,
          );
          changed = true;
          return {
            ...part,
            tool_call: {
              ...call,
              output: JSON.stringify({
                historical: true,
                reference,
                sourceMessageId: message.messageId,
                tool: call.name,
                note: 'Quelle eines abgeschlossenen Kunden. Bei Rückfragen mit arbeitsdaten_lesen nachladen; keine neue Schreibfreigabe.',
              }),
            },
          };
        }),
      );
      return changed ? { ...message, content } : message;
    }),
  );
}
