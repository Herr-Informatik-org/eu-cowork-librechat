import { FakeListChatModel } from '@langchain/core/utils/testing';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { z } from 'zod';
import { GraphEvents, HookRegistry, Providers, Run } from '@librechat/agents';
import { AIMessageChunk, HumanMessage } from '@librechat/agents/langchain/messages';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { IState, ToolExecuteBatchRequest } from '@librechat/agents';
import { installAgentWorkBudget, workBudgetClosure } from './budget';

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

let fixtureSequence = 0;
export async function fixture(options: FixtureOptions = {}) {
  const fixtureId = `budget-integration-${++fixtureSequence}`;
  const closureScope = {
    userId: 'synthetic-user',
    tenantId: 'cw01',
    conversationId: 'fixture-chat',
    taskId: fixtureId,
  };
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
        runId: fixtureId,
        agentId: 'agent',
        resumed: options.resumed,
        freeClosure: true,
        closureScope,
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
      guarded: registry.hasResultAlteringHooks(fixtureId),
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
    runId: fixtureId,
    graphConfig: {
      type: 'standard',
      signal: options.signal,
      ...(options.checkpointer ? { compileOptions: { checkpointer: options.checkpointer } } : {}),
      agents: [
        {
          agentId: 'agent',
          provider: Providers.OPENAI,
          clientOptions: {
            apiKey: `synthetic-no-network-${fixtureId}`,
            model: `gpt-4o-mini-${fixtureId}`,
            disableStreaming: !streaming,
            streaming,
            configuration: {
              baseURL: 'http://127.0.0.1:1/v1',
              fetch: async () =>
                Response.json({
                  id: 'synthetic-cleanup',
                  object: 'chat.completion',
                  created: 0,
                  model: 'gpt-4o-mini',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: '' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                }),
            },
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
      guarded: registry.hasResultAlteringHooks(fixtureId),
    });
    const content = messages
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      )
      .join('\n');
    if (
      (options.obey === 'warning' &&
        (content.includes('beinahe aufgebraucht') ||
          content.includes('Abschnittsgrenze nähert sich'))) ||
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
  class FixtureModel extends FakeListChatModel {
    async _generate(messages: BaseMessage[], options?: { signal?: AbortSignal }) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      options?.signal?.throwIfAborted();
      const closure = workBudgetClosure(closureScope);
      const message = closure ? new AIMessageChunk(closure) : next(messages);
      return { generations: [{ text: String(message.content), message }] };
    }

    async *_streamResponseChunks(messages: BaseMessage[], options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      modelStreamActive = true;
      try {
        const closure = workBudgetClosure(closureScope);
        yield new ChatGenerationChunk({
          text: '',
          message: closure ? new AIMessageChunk(closure) : next(messages),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        options?.signal?.throwIfAborted();
        yield new ChatGenerationChunk({
          text: '',
          message: new AIMessageChunk({
            content: '',
            response_metadata: { finish_reason: 'tool_calls' },
          }),
        });
      } finally {
        modelStreamActive = false;
      }
    }
  }
  run.Graph.overrideModel = new FixtureModel({
    responses: [''],
    ...(streaming ? {} : { disableStreaming: true }),
  });
  const config = {
    recursionLimit: limit,
    configurable: { thread_id: options.checkpointer ? 'budget-fixture' : fixtureId },
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
