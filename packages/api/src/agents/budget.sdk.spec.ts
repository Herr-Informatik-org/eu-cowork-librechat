import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemorySaver } from '@langchain/langgraph';
import { hasAgentWorkBudgetExhausted } from './budget';
import { fixture } from './budget.helper';

describe('work budget with the installed SDK and synthetic tools', () => {
  const previous = process.env.KISUNO_CWV01_SAFE_WORK;
  beforeAll(() => {
    process.env.KISUNO_CWV01_SAFE_WORK = 'true';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.KISUNO_CWV01_SAFE_WORK;
    else process.env.KISUNO_CWV01_SAFE_WORK = previous;
  });
  it('reproduces the unguarded 100 + 8 hard limit in an isolated SDK process', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'budget.failure.helper.cjs')],
      { encoding: 'utf8', timeout: 60000 },
    );
    expect(result.error).toBeUndefined();
    const receipt = result.stdout.split('\n').find((line) => line.startsWith('{"calls"'));
    expect(receipt).toBeDefined();
    expect(JSON.parse(receipt!)).toMatchObject({
      calls: 54,
      effects: 54,
      name: 'GraphRecursionError',
    });
    expect(JSON.parse(receipt!).message).toContain('108');
  }, 65000);

  it('lets an obeying model complete normally after the early warning', async () => {
    const f = await fixture({ obey: 'warning' });
    await expect(f.start()).resolves.toEqual(expect.any(Array));
    expect(f.calls()).toBe(42);
    expect(f.effects).toHaveLength(41);
    expect(f.run.getHaltReason()).toBeUndefined();
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(false);
  });

  it('gives one final model turn after refusal and retains its partial status on natural completion', async () => {
    const f = await fixture({ obey: 'denial' });
    await expect(f.start()).resolves.toEqual(expect.any(Array));
    expect(f.effects).toHaveLength(47);
    expect(f.calls()).toBe(48);
    expect(f.run.getHaltReason()).toBeUndefined();
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
  });

  it.each([false, true])(
    'stops a persistent loop before the hard cap (direct MCP-like tool: %s)',
    async (direct) => {
      const f = await fixture({ direct });
      await expect(f.start()).resolves.toBeDefined();
      expect(f.calls()).toBe(48);
      expect(f.effects).toHaveLength(47);
      expect(f.observed[f.observed.length - 1]?.step).toBe(95);
      expect(f.run.getHaltReason()).toBeUndefined();
      expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
      expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
    },
  );

  it.each([{ traditional: true }, { direct: true, mixed: true }])(
    'guards traditional or mixed direct/event tools without relying on hosted definitions: %j',
    async (options) => {
      const f = await fixture({ ...options, limit: 20 });
      await expect(f.start()).resolves.toBeDefined();
      expect(f.effects).toHaveLength(7);
      expect(f.calls()).toBe(8);
      expect(f.effects.every((effect) => effect.call <= 7)).toBe(true);
      expect(f.run.getHaltReason()).toBeUndefined();
      expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
    },
  );

  it('does not override an existing permission denial', async () => {
    const f = await fixture({ existingDenial: true, limit: 20 });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects).toHaveLength(0);
    expect(f.run.getHaltReason()).toBeUndefined();
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
  });

  it('does not start any effect from a parallel denied batch', async () => {
    const f = await fixture({ parallel: 4, limit: 20 });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects).toHaveLength(7 * 4);
    expect(f.effects.every((effect) => effect.call <= 7)).toBe(true);
    expect(f.calls()).toBe(8);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
  });

  it('preserves cancellation after a confirmed effect without restarting work', async () => {
    const controller = new AbortController();
    const f = await fixture({ signal: controller.signal, onEffect: () => controller.abort() });
    await expect(f.start()).rejects.toBeDefined();
    expect(f.effects).toHaveLength(1);
    expect(f.calls()).toBe(1);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(false);
  });

  it('resumes an approved checkpoint with a new relative budget, preserving the pending tool', async () => {
    const checkpointer = new MemorySaver();
    const initial = await fixture({ checkpointer, askAt: 5, limit: 20 });
    await initial.start();
    expect(initial.run.getInterrupt()).toBeDefined();
    expect(initial.effects).toHaveLength(4);
    const resumed = await fixture({ checkpointer, resumed: true, limit: 20 });
    await resumed.run.resume({ 'call-5-0': { type: 'approve' } }, resumed.config);
    expect(resumed.effects[0]?.call).toBe(0);
    expect(resumed.observed[0]?.step).toBeGreaterThan(1);
    expect(resumed.effects.length).toBeGreaterThan(4);
    expect(resumed.run.getHaltReason()).toBeUndefined();
    expect(hasAgentWorkBudgetExhausted(resumed.run)).toBe(true);
  });

  it('preserves a user cancellation before work starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = await fixture({ signal: controller.signal });
    await expect(f.start()).rejects.toBeDefined();
    expect(f.effects).toHaveLength(0);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(false);
  });
});
