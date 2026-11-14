import { HookRegistry } from '@librechat/agents';
import { installAgentWorkBudget, workBudgetClosure } from './budget';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  reserveWorkCost,
  settleWorkCost,
  WORK_COST_DAYS,
  usageCost,
  estimateReservation,
  createWorkCostFetch,
  cwv01TokenConfig,
  WORK_COST_CALLS,
  WORK_COST_SETTINGS,
  reconcileWorkCosts,
} from './costs';
import type { CostScope, CostDependencies, WorkFetch } from './costs';

let server: MongoMemoryServer;
let deps: CostDependencies;
let now: Date;
const scope: CostScope = {
  userId: 'user-a',
  tenantId: 'cw01',
  conversationId: 'chat-a',
  taskId: 'task-a',
};
const oldFlag = process.env.KISUNO_CWV01_SAFE_WORK;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'work_cost_test' });
  deps = {
    db: mongoose.connection.db!,
    secret: randomBytes(32).toString('hex'),
    now: () => now,
    requestLimit: 10,
    dayLimit: 50,
  };
}, 60000);
beforeEach(async () => {
  now = new Date('2026-11-14T10:00:00Z');
  await deps.db.collection(WORK_COST_DAYS).deleteMany({});
  await deps.db.collection(WORK_COST_SETTINGS).deleteMany({});
  await deps.db.collection(WORK_COST_CALLS).deleteMany({});
  await deps.db.collection('eucowork_router_log').deleteMany({});
  process.env.KISUNO_CWV01_SAFE_WORK = 'true';
});
afterAll(async () => {
  if (oldFlag == null) delete process.env.KISUNO_CWV01_SAFE_WORK;
  else process.env.KISUNO_CWV01_SAFE_WORK = oldFlag;
  await mongoose.disconnect();
  await server.stop();
});
it('atomically reserves against the request cap across concurrent model calls', async () => {
  const result = await Promise.allSettled(
    Array.from({ length: 4 }, () => reserveWorkCost(scope, 4_000_000, deps)),
  );
  expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
  expect(result.filter((x) => x.status === 'rejected')).toHaveLength(2);
});
it('settles a reservation only once and uses actual provider cost', async () => {
  const r = await reserveWorkCost(scope, 4_000_000, deps);
  await settleWorkCost(r, 0.3, deps);
  await settleWorkCost(r, 0.3, deps);
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114).toEqual({ spent: 300000, reserved: 0 });
  expect(
    Object.values(row?.jobs ?? {}).map((value) => ({
      spent: (value as { spent: number }).spent,
      reserved: (value as { reserved: number }).reserved,
    })),
  ).toEqual([{ spent: 300000, reserved: 0 }]);
});
it('seeds the real Zurich day including previous spend, without charging old estimates twice', async () => {
  await deps.db.collection('eucowork_router_log').insertMany([
    { userId: scope.userId, ts: new Date('2026-11-13T23:05:00Z'), usd: 49.5 },
    { userId: scope.userId, ts: new Date('2026-11-13T22:55:00Z'), usd: 80 },
    { userId: 'other-user', ts: now, usd: 100 },
  ]);
  await expect(reserveWorkCost(scope, 1_000_000, deps)).rejects.toMatchObject({
    code: 'KISUNO_COST_LIMIT',
  });
  const r = await reserveWorkCost(scope, 100000, deps);
  await settleWorkCost(r, 0.1, deps);
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114.spent).toBe(49_600_000);
});
it('retains the task limit across midnight while resetting the daily counter', async () => {
  const first = await reserveWorkCost(scope, 9_000_000, deps);
  await settleWorkCost(first, 9, deps);
  now = new Date('2026-11-14T23:01:00Z');
  await expect(reserveWorkCost(scope, 2_000_000, deps)).rejects.toMatchObject({
    code: 'KISUNO_COST_LIMIT',
  });
  await expect(
    reserveWorkCost({ ...scope, taskId: 'new-task' }, 2_000_000, deps),
  ).resolves.toBeDefined();
});
it('isolates users, tenants and tasks', async () => {
  const r = await reserveWorkCost(scope, 10_000_000, deps);
  await settleWorkCost(r, 10, deps);
  await expect(reserveWorkCost(scope, 1, deps)).rejects.toThrow();
  for (const next of [
    { ...scope, userId: 'other' },
    { ...scope, tenantId: 'other' },
    { ...scope, taskId: 'other' },
  ]) {
    await expect(reserveWorkCost(next, 1, deps)).resolves.toBeDefined();
  }
});
it('uses provider cost in preference to price-table estimates and includes paid cache writes', () => {
  expect(usageCost({ cost: 0.8425114 }, 'openai/gpt-5.6-sol')).toBe(0.8425114);
  expect(
    usageCost(
      {
        prompt_tokens: 100000,
        completion_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 90000, cache_write_tokens: 10000 },
      },
      'openai/gpt-5.6-sol',
    ),
  ).toBeCloseTo(0.106);
  expect(
    usageCost({ prompt_tokens: 300000, completion_tokens: 1000 }, 'openai/gpt-5.6-sol'),
  ).toBeCloseTo(2.43);
});
it('supplies verified fallback prices without overriding configured administrator tariffs', () => {
  expect(cwv01TokenConfig(undefined, 'openai/gpt-5.6-sol')?.['openai/gpt-5.6-sol'].completion).toBe(
    20,
  );
  expect(
    cwv01TokenConfig(undefined, 'openai/gpt-5.6-sol', 300000)?.['openai/gpt-5.6-sol'].completion,
  ).toBe(30);
  const configured = { 'openai/gpt-5.6-sol': { prompt: 7, completion: 35, context: 200000 } };
  expect(cwv01TokenConfig(configured, 'openai/gpt-5.6-sol')).toBe(configured);
  delete process.env.KISUNO_CWV01_SAFE_WORK;
  const original = { model: { prompt: 1, completion: 2, context: 100 } };
  expect(cwv01TokenConfig(original, 'openai/gpt-5.6-sol')).toBe(original);
});
it('preserves explicit output limits and supplies a bounded default for reservations', async () => {
  const input = {
    model: 'openai/gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Test' }],
    max_completion_tokens: 30000,
  };
  const result = await estimateReservation(JSON.stringify(input));
  expect(JSON.parse(result.body)).toEqual(input);
  expect(result.amount).toBeGreaterThan(600000);
  await expect(
    estimateReservation(JSON.stringify({ ...input, max_completion_tokens: -1 })),
  ).rejects.toThrow();
});
it('streams unchanged content, settles before completion, and never logs request content', async () => {
  const body =
    'data: {"choices":[{"delta":{"content":"Antwort"}}]}\n\ndata: {"id":"generation-1","usage":{"cost":0.12}}\n\ndata: [DONE]\n\n';
  const transport: WorkFetch = jest.fn(
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const wrapped = createWorkCostFetch(transport, scope, deps);
  const response = await wrapped('http://mcp-gateway:3020/router/v1/direct/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'openai/gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Privater Testinhalt' }],
    }),
  });
  expect(await response.text()).toBe(body);
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114).toEqual({ spent: 120000, reserved: 0 });
  expect(JSON.stringify(row)).not.toContain('Privater Testinhalt');
});
it('does not submit a model request when its budget cannot be reserved', async () => {
  const transport: WorkFetch = jest.fn();
  const wrapped = createWorkCostFetch(transport, scope, { ...deps, requestLimit: 0.01 });
  const response = await wrapped('http://mcp-gateway:3020/router/v1/direct/chat/completions', {
    method: 'POST',
    body: '{"model":"openai/gpt-5.6-sol","messages":[]}',
  });
  expect(response.status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
it('retains a reservation after an ambiguous network failure', async () => {
  const transport: WorkFetch = jest.fn(async () => {
    throw new Error('connection lost');
  });
  const wrapped = createWorkCostFetch(transport, scope, deps);
  await expect(
    wrapped('http://mcp-gateway:3020/router/v1/direct/chat/completions', {
      method: 'POST',
      body: '{"model":"openai/gpt-5.6-sol","messages":[]}',
    }),
  ).rejects.toThrow('connection lost');
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114.reserved).toBeGreaterThan(0);
});

it('deduplicates historical provider generations before seeding the daily cap', async () => {
  await deps.db.collection('eucowork_router_log').insertMany([
    { userId: scope.userId, generationId: 'same', ts: now, usd: 30 },
    { userId: scope.userId, generationId: 'same', ts: now, usd: 30 },
  ]);
  await expect(reserveWorkCost(scope, 1_000_000, deps)).resolves.toBeDefined();
});
it('reconciles an unknown reserved generation only against its own actual provider receipt', async () => {
  const reservation = await reserveWorkCost(scope, 2_000_000, deps);
  await deps.db.collection(WORK_COST_CALLS).insertOne({
    ...scope,
    state: 'unknown',
    generationId: 'generation-own',
    reservation,
    at: new Date(0),
  });
  await deps.db
    .collection('eucowork_router_log')
    .insertOne({ userId: 'other-user', generationId: 'generation-own', usd: 0.01 });
  await reconcileWorkCosts(scope, deps);
  let row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114.reserved).toBe(2_000_000);
  await deps.db
    .collection('eucowork_router_log')
    .insertOne({ userId: scope.userId, generationId: 'generation-own', usd: 0.5 });
  await reconcileWorkCosts(scope, deps);
  await reconcileWorkCosts(scope, deps);
  row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114).toEqual({ reserved: 0, spent: 500000 });
});

it('applies admin-panel limit changes on the next model admission without resetting spent cost', async () => {
  const first = await reserveWorkCost(scope, 4_000_000, deps);
  await settleWorkCost(first, 4, deps);
  await deps.db
    .collection<{
      _id: string;
      requestLimit: number;
      dayLimit: number;
      warning: number;
    }>(WORK_COST_SETTINGS)
    .updateOne(
      { _id: scope.tenantId },
      { $set: { requestLimit: 3, dayLimit: 20, warning: 1 } },
      { upsert: true },
    );
  await expect(reserveWorkCost(scope, 1, deps)).rejects.toMatchObject({
    code: 'KISUNO_COST_LIMIT',
  });
  await deps.db
    .collection(WORK_COST_SETTINGS)
    .updateOne({}, { $set: { requestLimit: 20, dayLimit: 100 } });
  await expect(reserveWorkCost(scope, 10_000_000, deps)).resolves.toBeDefined();
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114.spent).toBe(4_000_000);
});

it('ends an exhausted work section without any provider call, cost reservation or iterator cancellation', async () => {
  const closed = { ...scope, taskId: 'closed-free-section' };
  const registry = new HookRegistry();
  installAgentWorkBudget({
    registry,
    runId: closed.taskId,
    agentId: 'agent',
    limit: 20,
    freeClosure: true,
    closureScope: closed,
    readModelStep: () => 15,
  });
  const decision = await registry.getMatchers('PreToolUse')[0].hooks[0](
    {
      hook_event_name: 'PreToolUse',
      runId: closed.taskId,
      executingAgentId: 'agent',
      toolName: 'read_record',
      toolInput: {},
      toolUseId: 'synthetic-call',
    },
    new AbortController().signal,
  );
  expect(decision).toMatchObject({ decision: 'deny' });
  expect(decision?.preventContinuation).not.toBe(true);
  expect(workBudgetClosure(closed)).toContain('pausiert');
  expect(workBudgetClosure({ ...closed, userId: 'other-user' })).toBeUndefined();
  expect(workBudgetClosure({ ...closed, tenantId: 'other-tenant' })).toBeUndefined();
  expect(workBudgetClosure({ ...closed, conversationId: 'other-chat' })).toBeUndefined();
  const provider = jest.fn(async () => {
    throw new Error('No model call permitted');
  });
  const transport = createWorkCostFetch(provider, closed, deps);
  const response = await transport('https://synthetic.invalid/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'openai/gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Continue' }],
    }),
  });
  expect((await response.json()).usage.cost).toBe(0);
  expect(provider).not.toHaveBeenCalled();
  expect(await deps.db.collection(WORK_COST_DAYS).countDocuments()).toBe(0);
});

it('prunes old settled task metadata while retaining every unresolved reservation', async () => {
  const done = await reserveWorkCost(scope, 1_000_000, deps);
  await settleWorkCost(done, 0.1, deps);
  const pending = await reserveWorkCost({ ...scope, taskId: 'old-unknown' }, 1_000_000, deps);
  now = new Date('2027-03-01T10:00:00Z');
  await reserveWorkCost({ ...scope, taskId: 'new-day' }, 1_000_000, deps);
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.jobs[done.task]).toBeUndefined();
  expect(row?.jobs[pending.task].reserved).toBe(1_000_000);
  expect(row?.days.d20261114.reserved).toBe(1_000_000);
  expect(row?.reservations[pending.id]).toBe(1_000_000);
  expect(row?.expiresAt).toBeUndefined();
});

it('starts ledger retention only after every provider reservation has been settled', async () => {
  const first = await reserveWorkCost(scope, 1_000_000, deps);
  const second = await reserveWorkCost(scope, 1_000_000, deps);
  await settleWorkCost(first, 0.1, deps);
  expect((await deps.db.collection(WORK_COST_DAYS).findOne({}))?.expiresAt).toBeUndefined();
  await settleWorkCost(second, 0.2, deps);
  const settled = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(settled?.expiresAt).toEqual(new Date(+now + 90 * 86400000));
});

it('never seeds a managed generation a second time after a cross-midnight completion', async () => {
  const original = await reserveWorkCost(scope, 1_000_000, deps);
  await settleWorkCost(original, 0.5, deps);
  now = new Date('2026-11-14T23:01:00Z');
  await deps.db.collection('eucowork_router_log').insertOne({
    userId: scope.userId,
    generationId: 'finished-after-midnight',
    ts: now,
    usd: 0.5,
  });
  await reserveWorkCost({ ...scope, taskId: 'next-day' }, 1_000_000, deps);
  const row = await deps.db.collection(WORK_COST_DAYS).findOne({});
  expect(row?.days.d20261114.spent).toBe(500000);
  expect(row?.days.d20261115.spent).toBe(0);
});
