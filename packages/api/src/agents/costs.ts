import { createHmac, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import type { mongo } from 'mongoose';
import type { EndpointTokenConfig } from '~/types/tokens';
import type { TWorkCostSummary } from 'librechat-data-provider';
import { isSafeWorkEnabled } from './safeWork';
import { applyWorkCache, workCacheWriteMultiplier } from './cache';
import { workBudgetClosure } from './budget';
import { countTokens } from '~/utils/tokenizer';

export type WorkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Fetch = WorkFetch;
export interface CostScope {
  userId: string;
  tenantId: string;
  conversationId: string;
  taskId: string;
}
interface Price {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}
interface Usage {
  cost?: number;
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}
interface WireResponse {
  id?: string;
  model?: string;
  usage?: Usage;
  response?: { id?: string; model?: string; usage?: Usage };
}
interface CostDay {
  _id: string;
  days: Record<string, { spent: number; reserved: number }>;
  jobs: Record<string, { spent: number; reserved: number; updatedAt?: Date }>;
  reservations: Record<string, number>;
  userId: string;
  tenantId: string;
  expiresAt: Date;
  prunedDay?: string;
}
export interface CostDependencies {
  db: mongo.Db;
  secret: string;
  now?: () => Date;
  requestLimit?: number;
  dayLimit?: number;
  warning?: number;
}
interface Reservation {
  ledger: string;
  day: string;
  task: string;
  id: string;
  amount: number;
}
interface CostCall extends CostScope {
  _id: string;
  model: string;
  state: 'reserved' | 'unknown' | 'rejected' | 'completed';
  reservation: Reservation;
  prefixHashes: string[];
  toolsHash: string;
  inputBytes: number;
  at: Date;
  expiresAt: Date | null;
  generationId?: string;
  durationMs?: number;
  status?: number;
  usd?: number;
  costSource?: 'provider' | 'price-table';
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}
export const WORK_COST_DAYS = 'eucowork_work_cost_days';
export const WORK_COST_CALLS = 'eucowork_work_cost_calls';
const MICRO = 1_000_000;
const prices: Record<string, Price> = {
  'openai/gpt-5.6-sol': { prompt: 4, completion: 20, cacheRead: 0.4, cacheWrite: 5 },
  'openai/gpt-5.6-luna': { prompt: 0.2, completion: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'openai/gpt-6-astra': { prompt: 10, completion: 50, cacheRead: 1, cacheWrite: 12.5 },
  'deepseek/deepseek-v4.1-flash-1017': {
    prompt: 0.038,
    completion: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.038,
  },
  '~deepseek/deepseek-flash-latest': {
    prompt: 0.038,
    completion: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.038,
  },
  'deepseek/deepseek-v4-pro': { prompt: 0.9, completion: 1.5, cacheRead: 0.25, cacheWrite: 0.9 },
};
const baseFetches = new WeakMap<Fetch, Fetch>();
const indexes = new WeakMap<object, Promise<unknown>>();
async function ready(deps: CostDependencies): Promise<void> {
  let promise = indexes.get(deps.db);
  if (!promise) {
    promise = Promise.all([
      deps.db.collection(WORK_COST_DAYS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      deps.db.collection(WORK_COST_CALLS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      deps.db.collection(WORK_COST_CALLS).createIndex({ userId: 1, tenantId: 1, state: 1, at: 1 }),
    ]).catch((error) => {
      indexes.delete(deps.db);
      throw error;
    });
    indexes.set(deps.db, promise);
  }
  await promise;
}
/** Reconcile only a matching provider generation; unknown costs are never guessed away. */
export async function reconcileWorkCosts(scope: CostScope, deps: CostDependencies): Promise<void> {
  const calls = await deps.db
    .collection<CostCall>(WORK_COST_CALLS)
    .find({
      userId: scope.userId,
      tenantId: scope.tenantId,
      state: { $in: ['unknown', 'reserved'] },
      generationId: { $type: 'string' },
      at: { $lt: new Date(Date.now() - 60000) },
    })
    .limit(20)
    .toArray();
  for (const call of calls) {
    const actual = await deps.db
      .collection('eucowork_router_log')
      .findOne(
        { userId: scope.userId, generationId: call.generationId, usd: { $gte: 0 } },
        { projection: { usd: 1 } },
      );
    if (!actual || !Number.isFinite(actual.usd)) continue;
    await settleWorkCost(call.reservation, actual.usd, deps);
    await deps.db.collection<CostCall>(WORK_COST_CALLS).updateOne(
      { _id: call._id },
      {
        $set: {
          state: 'completed',
          usd: actual.usd,
          costSource: 'provider',
          expiresAt: new Date(Date.now() + 90 * 86400000),
        },
      },
    );
  }
}
const paused = new Map<string, string>();
export type WorkCostSummary = TWorkCostSummary;
const observers = new Map<string, (summary: WorkCostSummary) => Promise<void>>();
export function observeWorkCost(
  scope: CostScope,
  callback: (summary: WorkCostSummary) => Promise<void>,
): () => void {
  const key = scopeKey(scope);
  observers.set(key, callback);
  return () => {
    if (observers.get(key) === callback) observers.delete(key);
  };
}
export const WORK_COST_SETTINGS = 'eucowork_work_cost_settings';
interface CostLimits {
  requestLimit: number;
  dayLimit: number;
  warning: number;
}
async function limitsFor(scope: CostScope, deps: CostDependencies): Promise<CostLimits> {
  const saved = await deps.db
    .collection<CostLimits & { _id: string }>(WORK_COST_SETTINGS)
    .findOne({ _id: scope.tenantId });
  const limits = {
    requestLimit: saved?.requestLimit ?? deps.requestLimit ?? 10,
    dayLimit: saved?.dayLimit ?? deps.dayLimit ?? 50,
    warning: saved?.warning ?? deps.warning ?? positive(process.env.KISUNO_WORK_WARNING_USD, 1),
  };
  if (
    Object.values(limits).some((value) => !Number.isFinite(value) || value <= 0) ||
    limits.dayLimit < limits.requestLimit ||
    limits.warning > limits.requestLimit
  )
    throw new Error(
      'Die administrierten Kostenlimits sind ungültig. Es wurde kein Modellaufruf gestartet.',
    );
  return limits;
}
export async function readWorkCost(
  scope: CostScope,
  deps: CostDependencies = workCostDependencies(),
): Promise<WorkCostSummary | undefined> {
  const limits = await limitsFor(scope, deps);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(
    deps.now?.() ?? new Date(),
  );
  const row = await deps.db
    .collection<CostDay>(WORK_COST_DAYS)
    .findOne({ _id: token(deps.secret, JSON.stringify([scope.tenantId, scope.userId])) });
  if (!row) return;
  const job = row.jobs[token(deps.secret, scopeKey(scope))];
  return {
    requestUsd: (job?.spent ?? 0) / MICRO,
    requestReservedUsd: (job?.reserved ?? 0) / MICRO,
    dayUsd: (row.days['d' + day.replace(/-/g, '')]?.spent ?? 0) / MICRO,
    dayReservedUsd: (row.days['d' + day.replace(/-/g, '')]?.reserved ?? 0) / MICRO,
    requestLimitUsd: limits.requestLimit,
    dayLimitUsd: limits.dayLimit,
    warning: (job?.spent ?? 0) >= micros(limits.warning),
    at: Date.now(),
  };
}
const token = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('hex');
const scopeKey = (scope: CostScope) =>
  JSON.stringify([scope.tenantId, scope.userId, scope.conversationId, scope.taskId]);
const micros = (usd: number) => Math.ceil(usd * MICRO);
const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
export function workCostDependencies(): CostDependencies {
  if (!mongoose.connection.db || !process.env.KISUNO_WORK_SECRET) {
    throw new Error(
      'Die Kostenkontrolle ist nicht verfügbar. Es wurde kein Modellaufruf gestartet.',
    );
  }
  return {
    db: mongoose.connection.db,
    secret: process.env.KISUNO_WORK_SECRET,
    requestLimit: positive(process.env.KISUNO_WORK_REQUEST_USD, 10),
    dayLimit: positive(process.env.KISUNO_WORK_DAY_USD, 50),
  };
}
export function cwv01TokenConfig(
  original: EndpointTokenConfig | undefined,
  model?: string,
  inputTokens = 0,
): EndpointTokenConfig | undefined {
  if (!isSafeWorkEnabled() || !model || !prices[model] || original?.[model]) return original;
  const price = tierPrice(model, inputTokens);
  return {
    ...original,
    [model]: { ...original?.[model], ...price, context: original?.[model]?.context ?? 200000 },
  };
}
function tierPrice(model: string, input: number): Price {
  const price = prices[model];
  if (input <= 272000 || !model.startsWith('openai/')) return price;
  return {
    prompt: price.prompt * 2,
    completion: price.completion * 1.5,
    cacheRead: price.cacheRead * 2,
    cacheWrite: price.cacheWrite * 2,
  };
}
export function workCostPause(scope: CostScope): string | undefined {
  return paused.get(scopeKey(scope));
}
export async function pruneWorkCostLedger(
  id: string,
  day: string,
  deps: CostDependencies,
): Promise<void> {
  const collection = deps.db.collection<CostDay>(WORK_COST_DAYS);
  const row = await collection.findOne({ _id: id, prunedDay: { $ne: day } });
  if (!row) return;
  const cutoff = new Date(+(deps.now?.() ?? new Date()) - 90 * 86400000);
  const oldJobs = Object.entries(row.jobs)
    .filter(([, value]) => value.updatedAt && +value.updatedAt < +cutoff && value.reserved === 0)
    .slice(0, 500);
  const cutoffDay =
    'd' +
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' })
      .format(cutoff)
      .replace(/-/g, '');
  const oldDays = Object.entries(row.days).filter(
    ([key, value]) => key < cutoffDay && value.reserved === 0,
  );
  const conditions = oldJobs.flatMap(([key, value]) => [
    { [`jobs.${key}.reserved`]: 0 },
    { [`jobs.${key}.updatedAt`]: value.updatedAt },
  ]);
  const unset = Object.fromEntries([
    ...oldJobs.map(([key]) => [`jobs.${key}`, '']),
    ...oldDays.map(([key]) => [`days.${key}`, '']),
  ]);
  await collection.updateOne(
    { _id: id, prunedDay: { $ne: day }, ...(conditions.length ? { $and: conditions } : {}) },
    {
      $set: { prunedDay: day },
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
  );
}
async function activationTime(scope: CostScope, deps: CostDependencies, now: Date): Promise<Date> {
  const collection = deps.db.collection<{ _id: string; activatedAt?: Date }>(WORK_COST_SETTINGS);
  try {
    await collection.updateOne(
      { _id: scope.tenantId },
      { $setOnInsert: { activatedAt: now } },
      { upsert: true, writeConcern: { w: 'majority' } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  await collection.updateOne(
    { _id: scope.tenantId, activatedAt: { $exists: false } },
    { $set: { activatedAt: now } },
    { writeConcern: { w: 'majority' } },
  );
  const row = await collection.findOne({ _id: scope.tenantId }, { projection: { activatedAt: 1 } });
  if (!(row?.activatedAt instanceof Date))
    throw new Error('Der Beginn der Kostenkontrolle konnte nicht sicher bestimmt werden.');
  return row.activatedAt;
}
/** Historical provider costs seed the day once; existing token-price estimates are never charged again. */
export async function reserveWorkCost(
  scope: CostScope,
  amount: number,
  deps: CostDependencies = workCostDependencies(),
): Promise<Reservation> {
  if (!scope.userId || !scope.taskId || !scope.conversationId || !scope.tenantId) {
    throw new Error('Die Kostenkontrolle benötigt einen eindeutig zugeordneten Benutzerauftrag.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error('Ungültige Kostenreservierung.');
  await ready(deps);
  await reconcileWorkCosts(scope, deps);
  const now = deps.now?.() ?? new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(now);
  const id = token(deps.secret, JSON.stringify([scope.tenantId, scope.userId]));
  const dayKey = 'd' + day.replace(/-/g, '');
  const task = token(deps.secret, scopeKey(scope));
  const collection = deps.db.collection<CostDay>(WORK_COST_DAYS);
  try {
    await collection.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          userId: scope.userId,
          tenantId: scope.tenantId,
          days: {},
          jobs: {},
          reservations: {},
          expiresAt: new Date(+now + 90 * 86400_000),
        },
      },
      { upsert: true, writeConcern: { w: 'majority' } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  if (
    !(await collection.findOne(
      { _id: id, [`days.${dayKey}`]: { $exists: true } },
      { projection: { _id: 1 } },
    ))
  ) {
    const activatedAt = await activationTime(scope, deps, now);
    const history = await deps.db
      .collection('eucowork_router_log')
      .aggregate<{ spent: number }>(
        [
          {
            $match: {
              userId: scope.userId,
              usd: { $gte: 0 },
              ts: { $lte: activatedAt, $gte: new Date(+now - 27 * 3600_000) },
            },
          },
          {
            $match: {
              $expr: {
                $eq: [
                  { $dateToString: { date: '$ts', format: '%Y-%m-%d', timezone: 'Europe/Zurich' } },
                  day,
                ],
              },
            },
          },
          { $group: { _id: { $ifNull: ['$generationId', '$_id'] }, usd: { $max: '$usd' } } },
          { $group: { _id: null, spent: { $sum: '$usd' } } },
        ],
        { maxTimeMS: 5000 },
      )
      .toArray();
    await collection.updateOne(
      { _id: id, [`days.${dayKey}`]: { $exists: false } },
      {
        $set: { [`days.${dayKey}`]: { spent: micros(history[0]?.spent ?? 0), reserved: 0 } },
      },
      { writeConcern: { w: 'majority' } },
    );
  }
  const reservation = randomUUID();
  const limits = await limitsFor(scope, deps);
  const requestLimit = micros(limits.requestLimit);
  const dayLimit = micros(limits.dayLimit);
  const result = await collection.updateOne(
    {
      _id: id,
      $expr: {
        $and: [
          {
            $lte: [
              { $add: [`$days.${dayKey}.spent`, `$days.${dayKey}.reserved`, amount] },
              dayLimit,
            ],
          },
          {
            $lte: [
              {
                $add: [
                  { $ifNull: [`$jobs.${task}.spent`, 0] },
                  { $ifNull: [`$jobs.${task}.reserved`, 0] },
                  amount,
                ],
              },
              requestLimit,
            ],
          },
        ],
      },
    },
    {
      $inc: { [`days.${dayKey}.reserved`]: amount, [`jobs.${task}.reserved`]: amount },
      $set: {
        [`reservations.${reservation}`]: amount,
        [`jobs.${task}.updatedAt`]: now,
        expiresAt: new Date(+now + 90 * 86400_000),
      },
    },
    { writeConcern: { w: 'majority' } },
  );
  if (!result.matchedCount) {
    paused.set(scopeKey(scope), 'cost_limit');
    while (paused.size > 1000) paused.delete(paused.keys().next().value!);
    throw Object.assign(
      new Error(
        'Die Kostenobergrenze ist erreicht oder reicht für den nächsten Modellaufruf nicht aus. Der Auftrag ist pausiert; bestätigte Änderungen bleiben erhalten.',
      ),
      { code: 'KISUNO_COST_LIMIT' },
    );
  }
  await pruneWorkCostLedger(id, dayKey, deps).catch(() => undefined);
  return { ledger: id, day: dayKey, task, id: reservation, amount };
}
/** Unknown upstream outcomes retain their reservation until explicit reconciliation. */
export async function settleWorkCost(
  reservation: Reservation,
  usd: number,
  deps: CostDependencies = workCostDependencies(),
): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('Die tatsächlichen Modellkosten fehlen.');
  await deps.db.collection<CostDay>(WORK_COST_DAYS).updateOne(
    {
      _id: reservation.ledger,
      [`reservations.${reservation.id}`]: reservation.amount,
    },
    {
      $inc: {
        [`days.${reservation.day}.spent`]: micros(usd),
        [`days.${reservation.day}.reserved`]: -reservation.amount,
        [`jobs.${reservation.task}.spent`]: micros(usd),
        [`jobs.${reservation.task}.reserved`]: -reservation.amount,
      },
      $unset: { [`reservations.${reservation.id}`]: '' },
    },
    { writeConcern: { w: 'majority' } },
  );
}
export function usageCost(
  usage: Usage,
  model: string,
  cacheWriteMultiplier: number = 1,
): number | undefined {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0)
    return usage.cost;
  if (!prices[model]) return;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input == null || output == null) return;
  const price = tierPrice(model, input);
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const read = details?.cached_tokens ?? 0,
    write = details?.cache_write_tokens ?? 0;
  return (
    (Math.max(0, input - read - write) * price.prompt +
      read * price.cacheRead +
      write * price.cacheWrite * cacheWriteMultiplier +
      output * price.completion) /
    MICRO
  );
}
/** Tokenize the complete request with a safety margin and reserve uncached input/output cost. */
export async function estimateReservation(
  body: string,
): Promise<{ amount: number; body: string; model: string }> {
  const parsed = JSON.parse(body) as {
    model?: string;
    max_tokens?: number;
    max_completion_tokens?: number;
    max_output_tokens?: number;
    input?: object;
    messages?: object;
    tools?: object;
  };
  const model = parsed.model ?? '';
  const content = JSON.stringify([parsed.input, parsed.messages, parsed.tools]);
  const boundedMedia = content.replace(/data:[a-z0-9.+/-]+;base64,[a-z0-9+/=]+/gi, () =>
    ' [multimodal-input] '.repeat(8000),
  );
  const inputBound = Math.ceil((await countTokens(boundedMedia)) * 1.2) + 8192;
  const price = prices[model] ? tierPrice(model, inputBound) : undefined;
  // Unknown models remain usable, but their admission uses a conservative operator-configurable ceiling.
  const promptRate =
    (price?.cacheWrite ?? positive(process.env.KISUNO_WORK_MAX_INPUT_USD_PER_M, 50)) *
    workCacheWriteMultiplier(body);
  const outputRate =
    price?.completion ?? positive(process.env.KISUNO_WORK_MAX_OUTPUT_USD_PER_M, 250);
  const maxOutput =
    parsed.max_completion_tokens ??
    parsed.max_tokens ??
    parsed.max_output_tokens ??
    positive(process.env.KISUNO_WORK_DEFAULT_OUTPUT_TOKENS, 16384);
  if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0)
    throw new Error('Ungültige Ausgabelänge.');
  if (
    parsed.max_tokens == null &&
    parsed.max_completion_tokens == null &&
    parsed.max_output_tokens == null
  ) {
    if (parsed.input != null) parsed.max_output_tokens = maxOutput;
    else parsed.max_completion_tokens = maxOutput;
  }
  return {
    amount: Math.max(1, Math.ceil(inputBound * promptRate + maxOutput * outputRate)),
    body: JSON.stringify(parsed),
    model,
  };
}
export function createWorkCostFetch(
  original: Fetch | undefined,
  scope: CostScope,
  dependencies?: CostDependencies,
): Fetch {
  const fetcher = original ? (baseFetches.get(original) ?? original) : globalThis.fetch;
  const wrapped: Fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!/\/(chat\/completions|responses)$/.test(url.pathname)) return fetcher(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'POST') return fetcher(input, init);
    let rawBody: string | undefined;
    if (typeof init?.body === 'string') rawBody = init.body;
    else if (input instanceof Request) rawBody = await input.clone().text();
    if (!rawBody)
      throw new Error(
        'Die Kostenkontrolle konnte den Modellauftrag nicht sicher prüfen. Es wurde keine Anfrage gestartet.',
      );
    const closure = workBudgetClosure(scope);
    if (closure) {
      const request = JSON.parse(rawBody) as { model?: string; stream?: boolean };
      const result = {
        id: 'kisuno-work-close-' + scope.taskId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: closure }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
      };
      if (!request.stream) return Response.json(result);
      const chunk = {
        ...result,
        object: 'chat.completion.chunk',
        choices: [
          { index: 0, delta: { role: 'assistant', content: closure }, finish_reason: 'stop' },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      });
    }
    const deps = dependencies ?? workCostDependencies();
    const publish = async () => {
      const callback = observers.get(scopeKey(scope));
      if (!callback) return;
      const summary = await readWorkCost(scope, deps);
      if (summary) await callback(summary).catch(() => undefined);
    };
    let reservation: Reservation;
    let estimated: Awaited<ReturnType<typeof estimateReservation>>;
    try {
      estimated = await estimateReservation(applyWorkCache(rawBody, scope, deps.secret));
      reservation = await reserveWorkCost(scope, estimated.amount, deps);
    } catch (error) {
      await publish().catch(() => undefined);
      const limited = (error as { code?: string }).code === 'KISUNO_COST_LIMIT';
      return new Response(
        JSON.stringify({
          error: {
            type: 'kisuno_work_paused',
            code: limited ? 'KISUNO_COST_LIMIT' : 'KISUNO_WORK_CONTROL_UNAVAILABLE',
            message: (error as Error).message,
          },
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      );
    }
    const started = Date.now();
    const request = JSON.parse(estimated.body) as {
      model: string;
      messages?: object[];
      input?: object[];
      tools?: object[];
    };
    const prefix = JSON.stringify([request.tools, request.messages ?? request.input]);
    const hashes: string[] = [];
    for (let offset = 0; offset < Math.min(prefix.length, 1_048_576); offset += 8192) {
      hashes.push(token(deps.secret, prefix.slice(offset, offset + 8192)));
    }
    try {
      await deps.db.collection<CostCall>(WORK_COST_CALLS).insertOne(
        {
          _id: reservation.id,
          ...scope,
          taskId: reservation.task,
          model: request.model,
          state: 'reserved',
          reservation,
          prefixHashes: hashes,
          toolsHash: token(deps.secret, JSON.stringify(request.tools ?? [])),
          inputBytes: Buffer.byteLength(prefix),
          at: new Date(),
          expiresAt: null,
        },
        { writeConcern: { w: 'majority' } },
      );
    } catch (error) {
      await settleWorkCost(reservation, 0, deps);
      throw error;
    }
    await publish().catch(() => undefined);
    let response: Response;
    try {
      response = await fetcher(input, { ...init, body: estimated.body });
    } catch (error) {
      await deps.db
        .collection<CostCall>(WORK_COST_CALLS)
        .updateOne(
          { _id: reservation.id },
          { $set: { state: 'unknown', durationMs: Date.now() - started } },
        );
      await publish().catch(() => undefined);
      throw error;
    }
    if (!response.ok) {
      const rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
      if (rejected) await settleWorkCost(reservation, 0, deps);
      await deps.db.collection<CostCall>(WORK_COST_CALLS).updateOne(
        { _id: reservation.id },
        {
          $set: {
            state: rejected ? 'rejected' : 'unknown',
            status: response.status,
            ...(rejected ? { usd: 0, expiresAt: new Date(Date.now() + 90 * 86400_000) } : {}),
          },
        },
      );
      await publish().catch(() => undefined);
      return response;
    }
    let tail = '',
      final: WireResponse | undefined,
      generationId: string | undefined;
    const decoder = new TextDecoder();
    const inspect = (line: string) => {
      const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
      if (!raw || raw === '[DONE]') return;
      try {
        const event = JSON.parse(raw) as WireResponse;
        generationId = event.id ?? event.response?.id ?? generationId;
        if (event.usage || event.response?.usage) final = event;
      } catch {
        /* Incomplete JSON is retained by the bounded parser. */
      }
    };
    let finishing: Promise<void> | undefined;
    const finish = (): Promise<void> =>
      (finishing ??= (async () => {
        tail += decoder.decode();
        inspect(tail);
        const payload = final?.response ?? final;
        const cost = payload?.usage
          ? usageCost(
              payload.usage,
              payload.model ?? estimated.model,
              workCacheWriteMultiplier(estimated.body),
            )
          : undefined;
        if (payload?.usage && cost != null) {
          await settleWorkCost(reservation, cost, deps);
          const details = payload.usage.prompt_tokens_details ?? payload.usage.input_tokens_details;
          await deps.db.collection<CostCall>(WORK_COST_CALLS).updateOne(
            { _id: reservation.id },
            {
              $set: {
                state: 'completed',
                generationId: payload.id ?? generationId,
                model: payload.model ?? estimated.model,
                usd: cost,
                costSource: payload.usage.cost != null ? 'provider' : 'price-table',
                promptTokens: payload.usage.prompt_tokens ?? payload.usage.input_tokens,
                completionTokens: payload.usage.completion_tokens ?? payload.usage.output_tokens,
                cachedTokens: details?.cached_tokens ?? 0,
                cacheWriteTokens: details?.cache_write_tokens ?? 0,
                durationMs: Date.now() - started,
                expiresAt: new Date(Date.now() + 90 * 86400_000),
              },
            },
          );
          await publish().catch(() => undefined);
        } else {
          await deps.db.collection<CostCall>(WORK_COST_CALLS).updateOne(
            { _id: reservation.id },
            {
              $set: {
                state: 'unknown',
                ...(generationId ? { generationId } : {}),
                durationMs: Date.now() - started,
              },
            },
          );
        }
      })());
    if (!response.body) {
      await finish();
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            await finish();
            controller.close();
            return;
          }
          tail += decoder.decode(value, { stream: true });
          if (response.headers.get('content-type')?.includes('text/event-stream')) {
            let newline;
            while ((newline = tail.indexOf('\n')) >= 0) {
              inspect(tail.slice(0, newline));
              tail = tail.slice(newline + 1);
            }
          }
          if (tail.length > 1_000_000) tail = tail.slice(-1_000_000);
          controller.enqueue(value);
        } catch (error) {
          await finish().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await finish();
        }
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  baseFetches.set(wrapped, fetcher);
  return wrapped;
}
