/**
 * Stop reminder against a REAL `@librechat/agents` Run with a scripted model:
 * the second pass must continue the same response (content indices keep
 * growing) and see the finished pass plus exactly one reminder.
 */
import {
  Run,
  Providers,
  GraphEvents,
  MemorySaver,
  FakeChatModel,
  createContentAggregator,
} from '@librechat/agents';
import { createSteerIndexOffsetHandlers } from '../steering/offset';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { PLAN_TOOL_NAME } from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { IState, RunConfig } from '@librechat/agents';
import { continueOpenPlan } from './reminder';
import { createPlanTool } from './tool';

const OPEN_PLAN = {
  schritte: [
    { schritt: 'Offene Posten lesen', status: 'erledigt' },
    { schritt: 'Mahnliste erstellen', status: 'laeuft' },
  ],
};

async function buildRun(withCheckpointer: boolean) {
  const { contentParts, aggregateContent } = createContentAggregator();
  const forward = {
    handle: (event: string, data: unknown) => aggregateContent({ event, data } as never),
  };
  const indexOffset = { offset: 0 };
  const customHandlers = createSteerIndexOffsetHandlers(
    {
      [GraphEvents.ON_RUN_STEP]: forward,
      [GraphEvents.ON_RUN_STEP_DELTA]: forward,
      [GraphEvents.ON_RUN_STEP_COMPLETED]: forward,
      [GraphEvents.ON_MESSAGE_DELTA]: forward,
    } as RunConfig['customHandlers'],
    indexOffset,
  );
  const run = await Run.create<IState>({
    runId: `resp-${withCheckpointer ? 'cp' : 'plain'}`,
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId: 'agent-plan',
          provider: Providers.OPENAI,
          clientOptions: { model: 'gpt-4o-mini', streaming: true, streamUsage: false },
          instructions: 'Du bist hilfsbereit.',
          maxContextTokens: 8000,
          tools: [createPlanTool()],
        },
      ],
      ...(withCheckpointer ? { compileOptions: { checkpointer: new MemorySaver() } } : {}),
    },
    returnContent: true,
    customHandlers,
    tokenCounter: (message: BaseMessage) => String(message.content ?? '').length,
    indexTokenCountMap: {},
  });
  scriptModel(run, ['Ich beginne.', 'Zwischenstand.'], true);
  return { run, contentParts, indexOffset };
}

/** Scripted model; the SDK drops the override after each pass, so every pass sets its own. */
function scriptModel(run: Run<IState>, responses: string[], callPlan = false) {
  (run.Graph as unknown as { overrideModel: FakeChatModel }).overrideModel = new FakeChatModel({
    responses,
    toolCalls: callPlan
      ? [{ name: PLAN_TOOL_NAME, args: OPEN_PLAN, id: 'call_plan', type: 'tool_call' }]
      : [],
  });
}

const config = (threadId: string) => ({
  runName: 'AgentRun',
  configurable: { thread_id: threadId, user_id: 'user-1' },
  streamMode: 'values',
  version: 'v2' as const,
});

const texts = (parts: Array<{ type?: string; text?: string } | undefined>) =>
  parts.filter((part) => part?.type === 'text').map((part) => part?.text);

describe.each([false, true])('stop reminder with a real run (checkpointer: %s)', (withCp) => {
  jest.setTimeout(30000);

  it('continues the same response once and keeps the earlier content', async () => {
    const { run, contentParts, indexOffset } = await buildRun(withCp);
    const cfg = config(`thread-${withCp}`);
    const messages = [new HumanMessage('Erstelle die Mahnliste')];
    await run.processStream({ messages }, cfg);
    expect(texts(contentParts)).toEqual(['Ich beginne.', 'Zwischenstand.']);

    scriptModel(run, ['Alles erledigt.']);
    const processStream = jest.spyOn(run, 'processStream');
    const ran = await continueOpenPlan({
      run,
      messages,
      config: cfg,
      contentParts,
      indexOffset,
    });
    expect(ran).toBe(true);

    const input = (processStream.mock.calls[0][0] as { messages: BaseMessage[] }).messages;
    const reminders = input.filter((message) =>
      String(message.content).includes('<system-hinweis>'),
    );
    expect(reminders).toHaveLength(1);
    /** Stored state already holds the finished pass; otherwise the history is replayed. */
    expect(input).toHaveLength(withCp ? 1 : 5);
    expect(input[input.length - 1]).toBe(reminders[0]);
    expect(processStream.mock.calls[0][2]).toEqual(expect.objectContaining({ keepContent: true }));
    expect(texts(contentParts)).toEqual(['Ich beginne.', 'Zwischenstand.', 'Alles erledigt.']);
    const toolCalls = (contentParts as Array<{ type?: string } | undefined>).filter(
      (part) => part?.type === 'tool_call',
    );
    expect(toolCalls).toHaveLength(1);
  });
});
