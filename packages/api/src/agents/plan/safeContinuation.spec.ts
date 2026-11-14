jest.mock('../workspace', () => ({ hasIncompleteWorkSources: jest.fn(async () => false) }));
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import { HookRegistry } from '@librechat/agents';
import { PLAN_TOOL_NAME } from 'librechat-data-provider';
import { continueOpenPlan, getSafeWorkPauseReason } from './reminder';
import { installAgentWorkBudget } from '../budget';
import * as safeWork from '../safeWork';

const scope = { userId: 'user', tenantId: 'cwv01', conversationId: 'chat', taskId: 'generation' };
const part = (done = false) => ({
  type: 'tool_call',
  tool_call: {
    name: PLAN_TOOL_NAME,
    args: JSON.stringify({
      schritte: [
        { schritt: 'Einzelprüfung', status: 'erledigt' },
        { schritt: 'Rücklesen', status: done ? 'erledigt' : 'laeuft' },
      ],
    }),
  },
});
const previous = process.env.KISUNO_CWV01_SAFE_WORK;
beforeEach(() => {
  process.env.KISUNO_CWV01_SAFE_WORK = 'true';
  jest.spyOn(safeWork, 'saveSafeWorkTask').mockResolvedValue();
  jest.spyOn(safeWork, 'hasUncertainSafeWork').mockResolvedValue(false);
});
afterAll(() => {
  if (previous == null) delete process.env.KISUNO_CWV01_SAFE_WORK;
  else process.env.KISUNO_CWV01_SAFE_WORK = previous;
});
function fixture() {
  const content = [part()];
  let step = 81;
  const registry = new HookRegistry();
  const run = {
    processStream: jest.fn(
      async (_messages: object, _config: object, _options?: object) => undefined,
    ),
    getInterrupt: jest.fn(),
    getHaltReason: jest.fn(),
    getRunMessages: () => [new AIMessage({ id: 'last', content: 'Bestätigter Zwischenstand.' })],
  };
  const bind = installAgentWorkBudget({
    registry,
    runId: 'run',
    agentId: 'agent',
    limit: 100,
    readModelStep: () => step,
  });
  bind!(run);
  const warn = () =>
    registry.getMatchers('PreToolUse')[0].hooks[0](
      {
        hook_event_name: 'PreToolUse',
        runId: 'run',
        executingAgentId: 'agent',
        toolName: 'get_record_mcp_odoo-administrator',
        toolUseId: 'read',
        toolInput: {},
      },
      new AbortController().signal,
    );
  const params = {
    run,
    messages: [new HumanMessage('Freigegebenen Auftrag fortsetzen')],
    config: { version: 'v2' as const },
    contentParts: content,
    safeWork: scope,
    indexOffset: { offset: 0 },
  };
  return {
    run,
    params,
    content,
    warn,
    setStep: (value: number) => {
      step = value;
    },
  };
}
it('continues a soft budget stop with a new bounded section and retains confirmed tool history', async () => {
  const f = fixture();
  await f.warn();
  f.run.processStream.mockImplementation(async () => {
    f.content.push(part(true));
    return undefined;
  });
  expect(await continueOpenPlan(f.params)).toBe(true);
  expect(f.run.processStream).toHaveBeenCalledTimes(1);
  expect(f.run.processStream.mock.calls[0][2]).toMatchObject({ keepContent: true });
  expect(f.params.indexOffset.offset).toBe(1);
  expect(getSafeWorkPauseReason(f.run)).toBeUndefined();
  expect(safeWork.saveSafeWorkTask).toHaveBeenLastCalledWith(
    scope,
    expect.objectContaining({ status: 'completed', segments: 2 }),
  );
});
it('pauses durably after at most three sections, including the initial section', async () => {
  const f = fixture();
  await f.warn();
  expect(await continueOpenPlan(f.params)).toBe(true);
  expect(f.run.processStream).toHaveBeenCalledTimes(2);
  expect(getSafeWorkPauseReason(f.run)).toBe('section_limit');
  expect(safeWork.saveSafeWorkTask).toHaveBeenLastCalledWith(
    scope,
    expect.objectContaining({ status: 'paused_budget', segments: 3 }),
  );
});
it('a pending or uncertain write forbids automatic continuation', async () => {
  const f = fixture();
  await f.warn();
  jest.mocked(safeWork.hasUncertainSafeWork).mockResolvedValue(true);
  expect(await continueOpenPlan(f.params)).toBe(false);
  expect(f.run.processStream).not.toHaveBeenCalled();
  expect(getSafeWorkPauseReason(f.run)).toBe('uncertain_write');
});
it('never continues non-idempotent or unknown side effects automatically', async () => {
  const f = fixture();
  await f.warn();
  f.content.push({
    type: 'tool_call',
    tool_call: { name: 'post_message_mcp_odoo-administrator', args: '{}' },
  });
  await continueOpenPlan(f.params);
  expect(f.run.processStream).not.toHaveBeenCalled();
  expect(getSafeWorkPauseReason(f.run)).toBe('review_required');
});
it('a human approval pause, Stop or hook halt is preserved', async () => {
  for (const mode of ['interrupt', 'halt', 'abort']) {
    const f = fixture();
    await f.warn();
    if (mode === 'interrupt') f.run.getInterrupt.mockReturnValue({ pending: true });
    if (mode === 'halt') f.run.getHaltReason.mockReturnValue('denied');
    const controller = new AbortController();
    if (mode === 'abort') controller.abort();
    await continueOpenPlan({ ...f.params, signal: controller.signal });
    expect(f.run.processStream).not.toHaveBeenCalled();
  }
});
it('a checkpoint mismatch stops rather than replaying an old tool boundary', async () => {
  const f = fixture();
  await f.warn();
  await continueOpenPlan({
    ...f.params,
    run: {
      ...f.run,
      graphRunnable: {
        getState: async () => ({
          values: { messages: [new AIMessage({ id: 'other', content: 'Fremder Stand' })] },
        }),
      },
    },
  });
  expect(f.run.processStream).not.toHaveBeenCalled();
});
it('cannot continue when progress persistence fails', async () => {
  const f = fixture();
  await f.warn();
  jest.mocked(safeWork.saveSafeWorkTask).mockRejectedValue(new Error('database unavailable'));
  await continueOpenPlan(f.params);
  expect(f.run.processStream).not.toHaveBeenCalled();
  expect(getSafeWorkPauseReason(f.run)).toBe('progress_unavailable');
});
