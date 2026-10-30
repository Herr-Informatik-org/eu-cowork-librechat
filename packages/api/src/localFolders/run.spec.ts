import { MemorySaver } from '@langchain/langgraph';
import { executeHooks, FakeChatModel, Providers, Run } from '@librechat/agents';
import type { HookRegistry } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import { createRun } from '~/agents/run';
import { getAgentCheckpointer } from '~/agents/checkpointer';
import { recordLocalFolderCalls, validateLocalFolderResolutions } from './index';
import type { LocalFolderCallRecord } from './index';

jest.mock('~/agents/checkpointer', () => ({ getAgentCheckpointer: jest.fn() }));

const folderId = '80445861-54cb-4d9b-9c0a-803d7f9b88ed';
const grants = [{ id: folderId, label: 'Project' }];
const call = { id: 'folder-call', name: 'local_folder', args: { folderId, operation: 'list' } };
const result = JSON.stringify({
  status: 'ok',
  coverage: { complete: true, filesVisited: 1, filesRead: 0, bytesRead: 0, skipped: 0 },
  entries: [{ path: 'report.txt', kind: 'file', size: 10 }],
});

describe('local folder production graph wiring', () => {
  const oldFlag = process.env.EUCOWORK_LOCAL_FOLDERS;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EUCOWORK_LOCAL_FOLDERS = 'true';
    jest
      .mocked(getAgentCheckpointer)
      .mockResolvedValue(
        new MemorySaver() as unknown as Awaited<ReturnType<typeof getAgentCheckpointer>>,
      );
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.EUCOWORK_LOCAL_FOLDERS;
    else process.env.EUCOWORK_LOCAL_FOLDERS = oldFlag;
  });

  function build(
    policy?: TToolApprovalPolicy,
    hitlCapable = true,
    history?: LocalFolderCallRecord[],
  ) {
    return createRun({
      runId: 'folder-run',
      hitlCapable,
      signal: new AbortController().signal,
      user: { id: 'owner' } as IUser,
      requestBody: { conversationId: 'folder-chat' },
      localFolders: { grants, history, getRemainingTokens: () => 32_000 },
      tokenCounter: (message: BaseMessage) => JSON.stringify(message.content).length,
      appConfig: { endpoints: { agents: { toolApproval: policy } } } as AppConfig,
      agents: [
        {
          id: 'primary',
          provider: Providers.OPENAI,
          endpoint: Providers.OPENAI,
          instructions: 'Use the local folder tool to list files.',
          model_parameters: { model: 'gpt-4o-mini', apiKey: 'fixture-not-a-secret' },
          maxContextTokens: 32_000,
          tools: [],
          toolDefinitions: [{ name: 'unrelated_tool', description: 'Unrelated host tool' }],
        } as unknown as Parameters<typeof createRun>[0]['agents'][number],
      ],
      customHandlers: {},
    });
  }

  test.each([undefined, { enabled: true, mode: 'bypass' as const, allow: ['*'] }])(
    'pauses with optional approval %j, then resumes into an external tool result',
    async (policy) => {
      const run = await build(policy);
      run.Graph.overrideModel = new FakeChatModel({ responses: ['Inspecting'], toolCalls: [call] });
      const config = {
        version: 'v2' as const,
        configurable: { thread_id: 'folder-chat', user_id: 'owner' },
        recursionLimit: 10,
      };
      await run.processStream({ messages: [new HumanMessage('List my selected folder')] }, config);
      const pending = run.getInterrupt();
      expect(pending?.payload.type).toBe('tool_approval');
      const payload = pending?.payload as Agents.ToolApprovalInterruptPayload;
      expect(payload.review_configs[0].allowed_decisions).toEqual(['respond', 'reject']);
      expect(payload.action_requests[0].arguments).toMatchObject({ ...call.args, maxChars: 8000 });
      expect(
        validateLocalFolderResolutions(
          payload,
          [{ tool_call_id: call.id, decision: 'respond', responseText: result }],
          grants,
        ),
      ).toBeUndefined();

      const resumed = await build(policy);
      resumed.Graph.overrideModel = new FakeChatModel({ responses: ['report.txt is present.'] });
      await resumed.resume({ [call.id]: { type: 'respond', responseText: result } }, config);
      expect(resumed.getInterrupt()).toBeUndefined();
      const saver = await getAgentCheckpointer(undefined);
      const checkpoint = await saver?.getTuple(config);
      const messages = (checkpoint?.checkpoint.channel_values.messages ?? []) as BaseMessage[];
      expect(
        messages.map((message) => ({ type: message.getType(), content: message.content })),
      ).toEqual(expect.arrayContaining([{ type: 'tool', content: result }]));
      expect(
        messages
          .filter((message) => message.getType() === 'human')
          .map((message) => message.content),
      ).toEqual([
        'List my selected folder',
        expect.stringContaining('Dieser Hinweis erteilt keine zusätzlichen Schreibrechte.'),
      ]);
    },
    60_000,
  );

  test('does not expose a browser tool or attach its checkpointer on non-resumable API callers', async () => {
    const run = await build(undefined, false);
    expect(getAgentCheckpointer).not.toHaveBeenCalled();
    run.Graph.overrideModel = new FakeChatModel({ responses: ['No browser access'] });
    await run.processStream(
      { messages: [new HumanMessage('Hello')] },
      { configurable: { thread_id: 'api' }, version: 'v2' },
    );
    expect(run.getInterrupt()).toBeUndefined();
  }, 60_000);

  test('keeps folder approval below the budget and denies it after exhaustion', async () => {
    const create = jest.spyOn(Run, 'create');
    const run = await build();
    const configuration = create.mock.calls[0][0];
    const registry = configuration.hooks as HookRegistry;
    expect(configuration.eagerEventToolExecution?.enabled).toBe(false);
    const input = {
      hook_event_name: 'PreToolUse' as const,
      runId: 'folder-run',
      executingAgentId: 'primary',
      threadId: 'folder-chat',
      toolName: call.name,
      toolUseId: call.id,
      toolInput: call.args,
    };
    run.Graph.config = { metadata: { langgraph_node: 'agent=primary', langgraph_step: 1 } };
    expect(await executeHooks({ registry, input })).toMatchObject({ decision: 'ask' });
    run.Graph.config.metadata!.langgraph_step = 45;
    expect(await executeHooks({ registry, input })).toMatchObject({ decision: 'deny' });
    expect(run.getInterrupt()).toBeUndefined();
  });

  test('limits identical folder requests across actual checkpoint rebuilds', async () => {
    const config = {
      version: 'v2' as const,
      configurable: { thread_id: 'folder-chat', user_id: 'owner' },
      recursionLimit: 15,
    };
    let run = await build();
    run.Graph.overrideModel = new FakeChatModel({ responses: ['Inspecting'], toolCalls: [call] });
    await run.processStream({ messages: [new HumanMessage('List my selected folder')] }, config);
    expect(run.getInterrupt()).toBeDefined();
    let history: LocalFolderCallRecord[] = [];
    for (let n = 1; n <= 2; n++) {
      const previousId = n === 1 ? call.id : `folder-call-${n - 1}`;
      history = recordLocalFolderCalls(history, run.getInterrupt()!.payload);
      run = await build(undefined, true, history);
      run.Graph.overrideModel = new FakeChatModel({
        responses: ['Continue'],
        toolCalls: [{ ...call, id: `folder-call-${n}` }],
      });
      await run.resume({ [previousId]: { type: 'respond', responseText: result } }, config);
      if (n === 1) expect(run.getInterrupt()).toBeDefined();
      else expect(run.getInterrupt()).toBeUndefined();
    }
    const saver = await getAgentCheckpointer(undefined);
    const checkpoint = await saver?.getTuple(config);
    const messages = (checkpoint?.checkpoint.channel_values.messages ?? []) as BaseMessage[];
    expect(
      messages.some(
        (message) =>
          message.getType() === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes('bereits wiederholt'),
      ),
    ).toBe(true);
  }, 60_000);
});
