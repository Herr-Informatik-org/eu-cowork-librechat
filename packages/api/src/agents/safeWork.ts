import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { getTenantId } from '@librechat/data-schemas';
import type { mongo } from 'mongoose';

export const SAFE_WORK_RECORDS = 'eucowork_safe_work_records';
export const SAFE_WORK_TASKS = 'eucowork_safe_work_tasks';
export const SAFE_WORK_MAX_SEGMENTS = 3;
export const SAFE_WORK_MAX_MS: number = 20 * 60_000;
const LEASE_MS = 5 * 60_000;
export const isSafeWorkEnabled = (): boolean => process.env.KISUNO_CWV01_SAFE_WORK === 'true';
const initialized = new WeakMap<object, Promise<unknown>>();

export interface SafeWorkScope {
  userId: string;
  tenantId?: string;
  conversationId: string;
  taskId: string;
}
export interface SafeUpdateInput {
  model: string;
  record_id: number;
  values: Record<string, string | number | boolean | null>;
  intent?: string;
}
interface JournalRow {
  _id: string;
  owner: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  taskHash: string;
  state: 'claimed' | 'attempted' | 'uncertain' | 'reconciling' | 'verified';
  valuesHash: string;
  valuesEnc?: string;
  leaseUntil: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
  history?: Array<{ taskHash: string; valuesHash: string }>;
  model: string;
  recordId: number;
}
export interface SafeWriteDependencies {
  db: mongo.Db;
  secret: string;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
  now?: () => number;
}
export const safeWorkError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });
const blocked = () =>
  safeWorkError(
    'SAFE_WORK_UNCERTAIN',
    'Eine vorherige Änderung ist noch nicht sicher abgeglichen. Es wird nichts erneut geschrieben. Bitte den Datensatz prüfen und den Auftrag danach fortsetzen.',
  );
const busy = () =>
  safeWorkError(
    'SAFE_WORK_BUSY',
    'Dieser Datensatz wird bereits bearbeitet. Es wurde keine weitere Änderung ausgeführt.',
  );

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
function fingerprint(secret: string, value: unknown): string {
  return createHmac('sha256', secret)
    .update('kisuno-safe-work-v1:' + canonical(value))
    .digest('hex');
}
function validInput(input: SafeUpdateInput): void {
  if (
    !input ||
    !/^[a-z][a-z0-9_.]{0,127}$/.test(input.model) ||
    !Number.isSafeInteger(input.record_id) ||
    input.record_id <= 0 ||
    !input.values ||
    Array.isArray(input.values) ||
    Object.getPrototypeOf(input.values) !== Object.prototype ||
    !Object.keys(input.values).length ||
    Object.keys(input.values).length > 32 ||
    canonical(input.values).length > 32_000 ||
    Object.entries(input.values).some(
      ([key, value]) =>
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
        ['id', 'constructor', 'prototype'].includes(key) ||
        (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
        (typeof value === 'number' && !Number.isFinite(value)),
    )
  ) {
    throw safeWorkError(
      'SAFE_WORK_UNSUPPORTED',
      'Der sichere Einzel-Schreibweg unterstützt diese Änderung nicht. Es wurde nichts geschrieben.',
    );
  }
}
export function isSafeUpdateSupported(input: SafeUpdateInput): boolean {
  try {
    validInput(input);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'SAFE_WORK_UNSUPPORTED') return false;
    throw error;
  }
}
function equalValue(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(actual) && typeof desired === 'number')
    return actual.length === 2 && actual[0] === desired;
  return actual === desired || (desired === null && actual === false);
}
function matches(record: Record<string, unknown>, values: SafeUpdateInput['values']): boolean {
  return Object.entries(values).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(record, key) && equalValue(record[key], value),
  );
}
/** Decode only the MCP JSON payload; never execute or follow instructions in tool output. */
export function safeWorkRecord(result: unknown, id: number): Record<string, unknown> {
  let value = Array.isArray(result) ? result[0] : result;
  if (Array.isArray(value))
    value = value
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  if (typeof value === 'string') {
    if (value.length > 2_000_000) throw blocked();
    try {
      value = JSON.parse(value);
    } catch {
      throw blocked();
    }
  }
  const record = (value as { record?: Record<string, unknown> })?.record;
  if (!record || record.id !== id) throw blocked();
  return record;
}
async function ready(db: mongo.Db): Promise<void> {
  let flight = initialized.get(db);
  if (!flight) {
    flight = Promise.all([
      db.collection(SAFE_WORK_RECORDS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db
        .collection(SAFE_WORK_RECORDS)
        .createIndex({ tenantId: 1, userId: 1, conversationId: 1, taskHash: 1, state: 1 }),
      db.collection(SAFE_WORK_TASKS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection(SAFE_WORK_TASKS).createIndex({ userId: 1, conversationId: 1 }),
      db
        .collection(SAFE_WORK_EFFECTS)
        .createIndex({ tenantId: 1, userId: 1, conversationId: 1, state: 1 }),
    ]).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, flight);
  }
  await flight;
}
export function safeWorkDependencies(): SafeWriteDependencies {
  if (!mongoose.connection.db || !process.env.KISUNO_WORK_SECRET) throw blocked();
  const secret = process.env.KISUNO_WORK_SECRET;
  const key = createHmac('sha256', secret).update('kisuno-safe-work-encryption-v1').digest();
  return {
    db: mongoose.connection.db,
    secret,
    encrypt: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        bytes.toString('base64url'),
      ].join('.');
    },
    decrypt: (value) => {
      const [version, iv, tag, bytes] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !bytes) throw blocked();
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        cipher.update(Buffer.from(bytes, 'base64url')),
        cipher.final(),
      ]).toString('utf8');
    },
  };
}

/**
 * One approved, absolute single-record update, including a fresh read and mandatory read-back.
 * The durable attempted barrier precedes the only write RPC. Unknown outcomes permit reads
 * only, including after crashes or lease expiry; a Mongo lease is never permission to retry.
 */
export async function runVerifiedOdooUpdate(
  params: {
    scope: SafeWorkScope;
    serverName: string;
    input: SafeUpdateInput;
    read: (fields: string[]) => Promise<unknown>;
    write: () => Promise<unknown>;
    signal?: AbortSignal;
  },
  dependencies: SafeWriteDependencies = safeWorkDependencies(),
): Promise<[string, unknown[]]> {
  const { scope, serverName, input, read, write, signal } = params;
  validInput(input);
  if (!scope.userId || !scope.conversationId || !scope.taskId || !dependencies.secret)
    throw blocked();
  const { db, secret, encrypt, decrypt } = dependencies;
  const now = dependencies.now ?? Date.now;
  const tenantId = scope.tenantId || getTenantId() || 'cw01';
  await ready(db);
  const collection = db.collection<JournalRow>(SAFE_WORK_RECORDS, {
    writeConcern: { w: 'majority' },
  });
  const key = fingerprint(secret, [tenantId, serverName, input.model, input.record_id]);
  const pendingOther = await collection.findOne(
    {
      _id: { $ne: key },
      tenantId,
      userId: scope.userId,
      conversationId: scope.conversationId,
      state: { $in: ['attempted', 'uncertain', 'reconciling'] },
    },
    { projection: { _id: 1 } },
  );
  if (
    pendingOther ||
    (await db.collection(SAFE_WORK_EFFECTS).findOne(
      {
        tenantId,
        userId: scope.userId,
        conversationId: scope.conversationId,
        state: 'attempted',
      },
      { projection: { _id: 1 } },
    ))
  )
    throw blocked();
  const valuesHash = fingerprint(secret, input.values);
  const taskHash = fingerprint(secret, [
    tenantId,
    scope.userId,
    scope.conversationId,
    scope.taskId,
  ]);
  const owner = randomUUID();
  const previous = await collection.findOne({ _id: key });
  const unresolved = previous && ['attempted', 'uncertain', 'reconciling'].includes(previous.state);
  if (previous && previous.leaseUntil.getTime() > now()) throw busy();
  if (
    unresolved &&
    (previous.userId !== scope.userId || previous.conversationId !== scope.conversationId)
  )
    throw blocked();
  const repeated =
    previous?.history?.some(
      (entry) => entry.taskHash === taskHash && entry.valuesHash === valuesHash,
    ) ?? false;
  const row: JournalRow = {
    _id: key,
    owner,
    userId: scope.userId,
    tenantId,
    conversationId: scope.conversationId,
    taskHash,
    state: unresolved ? 'reconciling' : 'claimed',
    valuesHash: unresolved ? previous.valuesHash : valuesHash,
    valuesEnc: unresolved ? previous.valuesEnc : encrypt(JSON.stringify(input.values)),
    leaseUntil: new Date(now() + LEASE_MS),
    updatedAt: new Date(now()),
    expiresAt: null,
    model: input.model,
    recordId: input.record_id,
  };
  if (previous) {
    const { _id: unused, ...claim } = row;
    void unused;
    const claimed = await collection.updateOne(
      {
        _id: key,
        owner: previous.owner,
        state: previous.state,
        updatedAt: previous.updatedAt,
        leaseUntil: { $lte: new Date(now()) },
      },
      { $set: claim },
    );
    if (claimed.matchedCount !== 1) throw busy();
  } else {
    try {
      await collection.insertOne(row);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw busy();
      throw error;
    }
  }
  let attempted = !!unresolved;
  let wrote = false;
  const markVerified = async (confirmedHash: string) => {
    const result = await collection.updateOne(
      { _id: key, owner, state: { $in: ['claimed', 'attempted', 'reconciling'] } },
      {
        $set: {
          state: 'verified',
          valuesHash: confirmedHash,
          leaseUntil: new Date(0),
          updatedAt: new Date(now()),
          expiresAt: null,
        },
        $unset: { valuesEnc: '' },
        $push: {
          history: {
            $each: [
              { taskHash: unresolved ? previous.taskHash : taskHash, valuesHash: confirmedHash },
            ],
            $slice: -512,
          },
        },
      },
    );
    if (result.matchedCount !== 1) throw blocked();
  };
  try {
    if (signal?.aborted)
      throw safeWorkError(
        'SAFE_WORK_CANCELLED',
        'Der Auftrag wurde vor einer neuen Änderung angehalten.',
      );
    const expected = unresolved
      ? (JSON.parse(decrypt(row.valuesEnc!)) as SafeUpdateInput['values'])
      : input.values;
    const fields = ['id', ...Object.keys(expected)];
    const before = safeWorkRecord(await read(fields), input.record_id);
    if (unresolved) {
      if (!matches(before, expected)) throw blocked();
      await markVerified(row.valuesHash);
      if (valuesHash !== row.valuesHash) throw blocked();
      return [
        JSON.stringify({
          success: true,
          record: before,
          verified: true,
          writeIssued: false,
          reconciled: true,
        }),
        [],
      ];
    }
    if (matches(before, input.values)) {
      await markVerified(valuesHash);
      return [
        JSON.stringify({
          success: true,
          record: before,
          verified: true,
          writeIssued: false,
          alreadyApplied: true,
        }),
        [],
      ];
    }
    if (repeated)
      throw safeWorkError(
        'SAFE_WORK_CONFLICT',
        'Eine bereits bestätigte Änderung wurde zwischenzeitlich verändert. Sie wird nicht automatisch erneut angewendet.',
      );
    if (signal?.aborted)
      throw safeWorkError(
        'SAFE_WORK_CANCELLED',
        'Der Auftrag wurde vor einer neuen Änderung angehalten.',
      );
    const barrier = await collection.updateOne(
      { _id: key, owner, state: 'claimed', leaseUntil: { $gt: new Date(now()) } },
      {
        $set: { state: 'attempted', updatedAt: new Date(now()), expiresAt: null },
      },
    );
    if (barrier.matchedCount !== 1) throw busy();
    attempted = true;
    wrote = true;
    // Even a lost/failed write response never triggers a second write. Read back instead.
    try {
      await write();
    } catch {
      /* The read-back decides whether the desired state is confirmed. */
    }
    const after = safeWorkRecord(await read(fields), input.record_id);
    if (!matches(after, input.values)) throw blocked();
    await markVerified(valuesHash);
    return [
      JSON.stringify({ success: true, record: after, verified: true, writeIssued: wrote }),
      [],
    ];
  } catch (error) {
    // A failed final persistence leaves the attempted barrier intact, so re-entry can only reconcile.
    await collection
      .updateOne(
        { _id: key, owner, state: { $ne: 'verified' } },
        {
          $set: {
            state: attempted ? 'uncertain' : 'claimed',
            leaseUntil: new Date(0),
            updatedAt: new Date(now()),
            expiresAt: attempted ? null : null,
          },
        },
      )
      .catch(() => undefined);
    throw error;
  }
}

export async function saveSafeWorkTask(
  scope: SafeWorkScope,
  update: {
    status: 'running' | 'paused_budget' | 'blocked' | 'completed';
    segments: number;
    plan?: unknown;
  },
  dependencies: SafeWriteDependencies = safeWorkDependencies(),
): Promise<void> {
  await ready(dependencies.db);
  const tenantId = scope.tenantId || getTenantId() || 'cw01';
  const id = fingerprint(dependencies.secret, [
    tenantId,
    scope.userId,
    scope.conversationId,
    scope.taskId,
  ]);
  await dependencies.db
    .collection<{ _id: string; [key: string]: unknown }>(SAFE_WORK_TASKS)
    .updateOne(
      { _id: id },
      {
        $setOnInsert: { startedAt: new Date() },
        $set: {
          userId: scope.userId,
          tenantId,
          conversationId: scope.conversationId,
          taskHash: id,
          status: update.status,
          segments: update.segments,
          ...(update.plan ? { planEnc: dependencies.encrypt(JSON.stringify(update.plan)) } : {}),
          updatedAt: new Date(),
          expiresAt: null,
        },
      },
      { upsert: true, writeConcern: { w: 'majority' } },
    );
}
export async function hasUncertainSafeWork(
  scope: SafeWorkScope,
  dependencies: SafeWriteDependencies = safeWorkDependencies(),
): Promise<boolean> {
  const tenantId = scope.tenantId || getTenantId() || 'cw01';
  const filter = {
    tenantId,
    userId: scope.userId,
    conversationId: scope.conversationId,
    state: { $in: ['attempted', 'uncertain', 'reconciling'] },
  };
  if (
    await dependencies.db.collection(SAFE_WORK_EFFECTS).findOne(filter, { projection: { _id: 1 } })
  )
    return true;
  return !!(await dependencies.db.collection(SAFE_WORK_RECORDS).findOne(
    {
      tenantId,
      userId: scope.userId,
      conversationId: scope.conversationId,
      state: { $in: ['attempted', 'uncertain', 'reconciling'] },
    },
    { projection: { _id: 1 } },
  ));
}

export const SAFE_WORK_EFFECTS = 'eucowork_safe_work_effects';
/** Never replay a non-idempotent Odoo mutation after a lost response or process crash. */
export async function runOdooEffectOnce(
  scope: SafeWorkScope,
  serverName: string,
  toolName: string,
  args: unknown,
  execute: () => Promise<unknown>,
  dependencies: SafeWriteDependencies = safeWorkDependencies(),
): Promise<unknown> {
  await ready(dependencies.db);
  const tenantId = scope.tenantId || getTenantId() || 'cw01';
  if (!scope.userId || !scope.conversationId || !scope.taskId) throw blocked();
  if (await hasUncertainSafeWork(scope, dependencies)) throw blocked();
  const collection = dependencies.db.collection<{
    _id: string;
    state: string;
    resultEnc?: string;
    [key: string]: unknown;
  }>(SAFE_WORK_EFFECTS);
  const id = fingerprint(dependencies.secret, [
    tenantId,
    scope.userId,
    scope.conversationId,
    serverName,
    toolName,
    args,
  ]);
  const previous = await collection.findOne({ _id: id });
  if (previous) {
    if (previous.state === 'verified' && previous.resultEnc)
      return JSON.parse(dependencies.decrypt(previous.resultEnc));
    throw blocked();
  }
  const taskHash = fingerprint(dependencies.secret, [
    tenantId,
    scope.userId,
    scope.conversationId,
    scope.taskId,
  ]);
  try {
    await collection.insertOne(
      {
        _id: id,
        tenantId,
        userId: scope.userId,
        conversationId: scope.conversationId,
        taskHash,
        state: 'attempted',
        toolName,
        updatedAt: new Date(),
        expiresAt: null,
      },
      { writeConcern: { w: 'majority' } },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw busy();
    throw error;
  }
  // A transport success is a receipt, not proof of a business-level effect. Even error receipts
  // are retained and never trigger an automatic second submission of the same operation.
  const result = await execute();
  await collection.updateOne(
    { _id: id, state: 'attempted' },
    {
      $set: {
        state: 'verified',
        resultEnc: dependencies.encrypt(JSON.stringify(result)),
        updatedAt: new Date(),
      },
    },
    { writeConcern: { w: 'majority' } },
  );
  return result;
}
