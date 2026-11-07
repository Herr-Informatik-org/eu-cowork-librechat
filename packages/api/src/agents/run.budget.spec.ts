import { Providers, Run } from '@librechat/agents';
import type { HookRegistry, IState, RunConfig } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import { createRun } from './run';
import { hasAgentWorkBudgetExhausted } from './budget';

type Agent = Parameters<typeof createRun>[0]['agents'][number];

describe('host work budget wiring', () => {
  it.each(['tools', 'toolDefinitions', 'brainTools'] as const)(
    'guards a standard run with only %s',
    async (toolField) => {
      let config: RunConfig | undefined;
      const graph = { config: { metadata: { langgraph_node: 'agent=agent', langgraph_step: 95 } } };
      const run = { Graph: graph } as unknown as Run<IState>;
      jest.spyOn(Run, 'create').mockImplementation(async (value) => {
        config = value;
        return run;
      });
      await createRun({
        runId: 'host-budget',
        allowWorkBudget: true,
        signal: new AbortController().signal,
        agents: [
          {
            id: 'agent',
            provider: Providers.OPENAI,
            [toolField]: [{ name: 'read_records' }],
          } as unknown as Agent,
        ],
        appConfig: {
          endpoints: { agents: { recursionLimit: 100, maxRecursionLimit: 100 } },
        } as AppConfig,
      });
      const hooks = config?.hooks as HookRegistry;
      expect(hooks.hasResultAlteringHooks('host-budget')).toBe(true);
      const result = await hooks.getMatchers('PreToolUse')[0].hooks[0](
        {
          hook_event_name: 'PreToolUse',
          runId: 'host-budget',
          executingAgentId: 'agent',
          toolName: 'read_records',
          toolInput: {},
          toolUseId: 'tool-call',
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ decision: 'deny' });
      expect(hasAgentWorkBudgetExhausted(run)).toBe(true);
    },
  );

  it('does not inject planning or execution hooks into a plain chat without tools', async () => {
    const create = jest.spyOn(Run, 'create').mockResolvedValue({} as Run<IState>);
    await createRun({
      runId: 'plain-chat',
      allowWorkBudget: true,
      signal: new AbortController().signal,
      agents: [{ id: 'agent', provider: Providers.OPENAI } as Agent],
    });
    expect(create.mock.calls[0][0].hooks).toBeUndefined();
  });

  it.each([undefined, false])(
    'keeps unsupported callers on the unchanged hard limit when allowWorkBudget is %s',
    async (allowWorkBudget) => {
      const create = jest.spyOn(Run, 'create').mockResolvedValue({} as Run<IState>);
      const appConfig = {
        endpoints: { agents: { recursionLimit: 100, maxRecursionLimit: 100 } },
      } as AppConfig;
      const result = await createRun({
        runId: 'api-caller',
        allowWorkBudget,
        signal: new AbortController().signal,
        appConfig,
        agents: [
          {
            id: 'agent',
            provider: Providers.OPENAI,
            toolDefinitions: [{ name: 'read_records' }],
          } as Agent,
        ],
      });
      expect(create.mock.calls[0][0].hooks).toBeUndefined();
      expect(hasAgentWorkBudgetExhausted(result)).toBe(false);
      expect(appConfig.endpoints?.agents).toEqual({ recursionLimit: 100, maxRecursionLimit: 100 });
    },
  );
});
