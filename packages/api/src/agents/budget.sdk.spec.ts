import { z } from 'zod';
import { GraphEvents, HookRegistry, Providers, Run } from '@librechat/agents';
import { AIMessageChunk, HumanMessage } from '@librechat/agents/langchain/messages';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { IState, ToolExecuteBatchRequest } from '@librechat/agents';
import { hasAgentWorkBudgetExhausted, installAgentWorkBudget } from './budget';

interface FixtureOptions {
  limit?: number;
  guarded?: boolean;
  obey?: 'warning' | 'denial';
  direct?: boolean;
  traditional?: boolean;
  mixed?: boolean;
  streaming?: boolean;
  existingDenial?: boolean;
  signal?: AbortSignal;
  resumed?: boolean;
  checkpointer?: MemorySaver;
  askAt?: number;
  parallel?: number;
  onEffect?: () => void;
}

async function fixture(options: FixtureOptions = {}) {
  const { limit = 100, guarded = true, direct = false, streaming = false } = options;
  const registry = new HookRegistry();
  const effects: Array<{ call: number; duringStream: boolean; guarded: boolean }> = [];
  const observed: Array<{ step: unknown; guarded: boolean }> = [];
  let modelCalls = 0;
  let modelStreamActive = false;
  if (options.askAt != null) {
    registry.register('PreToolUse', {
      hooks: [async () => (modelCalls === options.askAt ? { decision: 'ask' } : {})],
    });
  }
  if (options.existingDenial) {
    registry.register('PreToolUse', {
      hooks: [async () => ({ decision: 'deny', reason: 'Keine Berechtigung.' })],
    });
  }
  const bind = guarded
    ? installAgentWorkBudget({
        registry,
        limit,
        runId: 'budget-integration',
        agentId: 'agent',
        resumed: options.resumed,
        readModelStep: () => {
          const step = run.Graph?.config?.metadata?.langgraph_step;
          return typeof step === 'number' ? step : undefined;
        },
      })
    : undefined;
  const recordEffect = () => {
    effects.push({
      call: modelCalls,
      duringStream: modelStreamActive,
      guarded: registry.hasResultAlteringHooks('budget-integration'),
    });
    options.onEffect?.();
    return 'Bestätigtes synthetisches Ergebnis. Datei: export.csv';
  };
  const directTool = new DynamicStructuredTool({
    name: 'read_records_mcp_odoo',
    description: 'Synthetic local MCP-like fixture, with no network or persistent writes.',
    schema: z.object({}),
    func: async () => recordEffect(),
  });
  const run = await Run.create<IState>({
    runId: 'budget-integration',
    graphConfig: {
      type: 'standard',
      signal: options.signal,
      ...(options.checkpointer ? { compileOptions: { checkpointer: options.checkpointer } } : {}),
      agents: [
        {
          agentId: 'agent',
          provider: Providers.OPENAI,
          clientOptions: {
            apiKey: 'synthetic-no-network',
            model: 'gpt-4o-mini',
            disableStreaming: !streaming,
          },
          toolDefinitions: options.traditional
            ? undefined
            : [
                {
                  name: 'read_records',
                  description: 'Synthetic hosted fixture, with no network or persistent writes.',
                  parameters: { type: 'object', properties: {} },
                },
              ],
          ...(direct ? { graphTools: [directTool] } : {}),
          ...(options.traditional ? { tools: [directTool] } : {}),
        },
      ],
    },
    preemption: { shouldPreempt: () => false },
    eagerEventToolExecution: { enabled: true },
    hooks: registry,
    ...(options.checkpointer ? { humanInTheLoop: { enabled: true } } : {}),
    returnContent: true,
    customHandlers: {
      [GraphEvents.ON_TOOL_EXECUTE]: {
        handle: async (_event: string, rawData: unknown) => {
          const data = rawData as ToolExecuteBatchRequest;
          data.resolve(
            data.toolCalls.map((call) => ({
              toolCallId: call.id,
              content: recordEffect(),
              status: 'success',
            })),
          );
        },
      },
    },
  });
  bind?.(run);
  const next = (messages: BaseMessage[]) => {
    modelCalls++;
    observed.push({
      step: run.Graph?.config?.metadata?.langgraph_step,
      guarded: registry.hasResultAlteringHooks('budget-integration'),
    });
    const content = messages.map((message) => String(message.content)).join('\n');
    if (
      (options.obey === 'warning' && content.includes('beinahe aufgebraucht')) ||
      (options.obey === 'denial' && content.includes('Werkzeugbudget ist aufgebraucht'))
    ) {
      return new AIMessageChunk('Teilresultat: export.csv ist vorhanden; weitere Daten fehlen.');
    }
    const name =
      options.traditional || (direct && (!options.mixed || modelCalls % 2 === 1))
        ? 'read_records_mcp_odoo'
        : 'read_records';
    return new AIMessageChunk({
      content: '',
      tool_call_chunks: Array.from({ length: options.parallel ?? 1 }, (_, index) => ({
        id: `call-${modelCalls}-${index}`,
        name,
        args: '{}',
        index,
      })),
    });
  };
  if (!run.Graph) {
    throw new Error('Missing synthetic graph');
  }
  run.Graph.overrideModel = {
    invoke: async (messages: BaseMessage[]) => next(messages),
    ...(streaming
      ? {
          stream: async (messages: BaseMessage[]) =>
            (async function* () {
              modelStreamActive = true;
              yield next(messages);
              await new Promise((resolve) => setTimeout(resolve, 0));
              yield new AIMessageChunk({
                content: '',
                response_metadata: { finish_reason: 'tool_calls' },
              });
              modelStreamActive = false;
            })(),
        }
      : {}),
  };
  const config = {
    recursionLimit: limit,
    configurable: { thread_id: 'budget-fixture' },
    streamMode: 'values' as const,
    version: 'v2' as const,
    signal: options.signal,
  };
  const start = () =>
    run.processStream(
      { messages: [new HumanMessage('Exportiere die vorhandenen synthetischen Daten.')] },
      config,
    );
  return { run, start, config, effects, observed, calls: () => modelCalls };
}

describe('work budget with the installed SDK and synthetic tools', () => {
  it('reproduces the unguarded 100 + 8 hard limit without any external operation', async () => {
    const f = await fixture({ guarded: false });
    await expect(f.start()).rejects.toMatchObject({ name: 'GraphRecursionError' });
    expect(f.calls()).toBe(54);
    expect(f.effects).toHaveLength(54);
    expect(f.observed[f.observed.length - 1]?.step).toBe(107);
  });

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
    expect(f.calls()).toBe(49);
    expect(f.run.getHaltReason()).toBeUndefined();
    expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
  });

  it.each([false, true])(
    'stops a persistent loop before the hard cap (direct MCP-like tool: %s)',
    async (direct) => {
      const f = await fixture({ direct });
      await expect(f.start()).resolves.toBeDefined();
      expect(f.calls()).toBe(49);
      expect(f.effects).toHaveLength(47);
      expect(f.observed[f.observed.length - 1]?.step).toBe(97);
      expect(f.run.getHaltReason()).toBe('agent_work_budget_exceeded');
      expect(hasAgentWorkBudgetExhausted(f.run)).toBe(true);
    },
  );

  it('blocks eager execution before dispatch, including the first round', async () => {
    const f = await fixture({ streaming: true, limit: 20 });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects.every((effect) => effect.guarded && !effect.duringStream)).toBe(true);
    expect(
      f.effects.filter((effect) => effect.guarded).every((effect) => !effect.duringStream),
    ).toBe(true);
    expect(f.effects.every((effect) => effect.call < 8)).toBe(true);
    expect(f.run.getHaltReason()).toBe('agent_work_budget_exceeded');
  });

  it.each([{ traditional: true }, { direct: true, mixed: true }])(
    'guards traditional or mixed direct/event tools without relying on hosted definitions: %j',
    async (options) => {
      const f = await fixture({ ...options, limit: 20 });
      await expect(f.start()).resolves.toBeDefined();
      expect(f.effects).toHaveLength(7);
      expect(f.calls()).toBe(9);
      expect(f.effects.every((effect) => effect.call <= 7)).toBe(true);
      expect(f.run.getHaltReason()).toBe('agent_work_budget_exceeded');
    },
  );

  it('does not override an existing permission denial', async () => {
    const f = await fixture({ existingDenial: true, limit: 20 });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects).toHaveLength(0);
    expect(f.run.getHaltReason()).toBe('agent_work_budget_exceeded');
  });

  it('does not start any effect from a parallel denied batch', async () => {
    const f = await fixture({ parallel: 4, limit: 20 });
    await expect(f.start()).resolves.toBeDefined();
    expect(f.effects).toHaveLength(7 * 4);
    expect(f.effects.every((effect) => effect.call <= 7)).toBe(true);
    expect(f.calls()).toBe(9);
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
    expect(resumed.run.getHaltReason()).toBe('agent_work_budget_exceeded');
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
