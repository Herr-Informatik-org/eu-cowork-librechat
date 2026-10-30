import { HookRegistry } from '@librechat/agents';
import type { HookInputByEvent } from '@librechat/agents';
import { hasAgentWorkBudgetExhausted, installAgentWorkBudget } from './budget';

const signal = new AbortController().signal;
const scope = { runId: 'run', executingAgentId: 'agent' };
const entry = {
  toolName: 'write_record',
  toolInput: {},
  toolUseId: 'call',
  status: 'success' as const,
  toolOutput: 'confirmed',
};

function fixture(limit = 100, resumed = false) {
  const registry = new HookRegistry();
  let step: number | undefined = 1;
  const run = {};
  const bind = installAgentWorkBudget({
    registry,
    limit,
    resumed,
    runId: 'run',
    agentId: 'agent',
    readModelStep: () => step,
  });
  bind?.(run);
  const pre = (overrides: Partial<HookInputByEvent['PreToolUse']> = {}) =>
    registry
      .getMatchers('PreToolUse')[0]
      .hooks[0]({ hook_event_name: 'PreToolUse', ...scope, ...entry, ...overrides }, signal);
  return {
    registry,
    run,
    bind,
    pre,
    setStep: (value: number | undefined) => (step = value),
  };
}

describe('agent work budget', () => {
  it.each([0, 1, 11, -1, 12.5, NaN, Infinity])('leaves limit %s unchanged', (limit) => {
    const f = fixture(limit);
    expect(f.bind).toBeUndefined();
    expect(f.registry.getMatchers('PreToolUse')).toHaveLength(0);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(false);
  });

  it('guides complete batched reads without granting write permission', async () => {
    const f = fixture();
    const result = await f.registry
      .getMatchers('RunStart')[0]
      .hooks[0]({ hook_event_name: 'RunStart', runId: 'run', messages: [] }, signal);
    expect(result?.additionalContext).toContain('tatsächliche Schema');
    expect(result?.additionalContext).toContain('keine zusätzlichen Schreibrechte');
    expect(result?.additionalContext).toContain(
      'ohne vom Nutzer verlangte Informationen wegzulassen',
    );
  });

  it('leaves one model turn after denial, then halts before a later wholly denied batch', async () => {
    const f = fixture();
    f.setStep(79);
    expect(await f.pre()).toEqual({});
    expect(f.registry.hasResultAlteringHooks('run')).toBe(true);
    f.setStep(81);
    expect(await f.pre()).toMatchObject({
      additionalContext: expect.stringContaining('beinahe'),
    });
    expect(f.registry.hasResultAlteringHooks('run')).toBe(true);
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(false);
    f.setStep(93);
    expect(await f.pre()).toEqual({});
    f.setStep(95);
    expect(await f.pre()).toMatchObject({ decision: 'deny' });
    expect(await f.pre()).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('nicht ausgeführt'),
    });
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
    f.setStep(97);
    expect(await f.pre()).toMatchObject({ decision: 'deny' });
    expect(await f.pre()).toMatchObject({
      decision: 'deny',
      preventContinuation: true,
      stopReason: 'agent_work_budget_exceeded',
    });
  });

  it('does not charge parallel calls as separate graph steps', async () => {
    const f = fixture();
    f.setStep(3);
    const early = await Promise.all(Array.from({ length: 200 }, () => f.pre()));
    expect(early.every((decision) => !decision?.decision)).toBe(true);
    expect(f.registry.hasResultAlteringHooks('run')).toBe(true);
    f.setStep(81);
    await f.pre();
    f.setStep(95);
    const decisions = await Promise.all(Array.from({ length: 200 }, () => f.pre()));
    expect(decisions.every((decision) => decision?.decision === 'deny')).toBe(true);
    expect(await f.pre()).not.toHaveProperty('preventContinuation');
  });

  it('uses a resumed invocation origin instead of interpreting its saved absolute step as usage', async () => {
    const f = fixture(100, true);
    f.setStep(901);
    expect(await f.pre()).toEqual({});
    f.setStep(979);
    expect(await f.pre()).toEqual({});
    f.setStep(981);
    expect(await f.pre()).toHaveProperty('additionalContext');
    f.setStep(993);
    expect(await f.pre()).toEqual({});
    f.setStep(995);
    expect(await f.pre()).toHaveProperty('decision', 'deny');
  });

  it('does not change unrelated runs or child agent policy', async () => {
    const f = fixture();
    f.setStep(99);
    expect(await f.pre({ runId: 'other' })).toEqual({});
    expect(await f.pre({ agentId: 'child' })).toEqual({});
    expect(await f.pre({ executingAgentId: 'other' })).toEqual({});
    expect(f.registry.hasResultAlteringHooks('run')).toBe(true);
  });

  it('fails closed on missing metadata after arming and never resets its exhausted latch', async () => {
    const f = fixture();
    f.setStep(81);
    await f.pre();
    f.setStep(undefined);
    expect(await f.pre()).toHaveProperty('decision', 'deny');
    await f.pre();
    f.setStep(95);
    expect(await f.pre()).toHaveProperty('decision', 'deny');
    f.setStep(97);
    expect(await f.pre()).toHaveProperty('preventContinuation', true);
    expect(hasAgentWorkBudgetExhausted(undefined)).toBe(false);
  });
});
