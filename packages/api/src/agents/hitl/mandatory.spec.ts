import { HookRegistry, createToolPolicyHook, executeHooks } from '@librechat/agents';
import type { MCPOptions } from 'librechat-data-provider';
import { buildMandatoryApproval, isProtectedMCPAlias } from './mandatory';

const config = {
  office: {
    type: 'streamable-http',
    url: 'http://office/mcp',
    requireToolApproval: ['create-*', 'update.v1'],
  },
} as Record<string, MCPOptions>;
const input = (name = 'create-event_mcp_office') => ({
  hook_event_name: 'PreToolUse' as const,
  runId: 'r',
  toolUseId: 't',
  toolName: name,
  toolInput: { subject: 'Team meeting' },
});
async function check(policy = buildMandatoryApproval(config, true), extra = {}) {
  const registry = new HookRegistry();
  registry.register('PreToolUse', {
    hooks: [createToolPolicyHook({ mode: 'bypass', allow: ['*'] })],
  });
  registry.register('PreToolUse', { hooks: [policy.hook] });
  return executeHooks({ registry, input: { ...input(), ...extra } });
}

describe('mandatory MCP approvals', () => {
  test('forces a fresh ask despite bypass/allow on each invocation', async () => {
    for (let n = 0; n < 2; n++) {
      const result = await check();
      expect(result.decision).toBe('ask');
      expect(result.allowedDecisions).toEqual(['approve', 'reject', 'edit']);
    }
  });
  test('unrelated reads still work', async () => {
    expect((await check(undefined, { toolName: 'list-events_mcp_office' })).decision).toBe('allow');
  });
  test('non-resumable callers and subagents are denied', async () => {
    expect((await check(buildMandatoryApproval(config, false))).decision).toBe('deny');
    expect((await check(undefined, { agentId: 'child' })).decision).toBe('deny');
  });
  test('remote programmatic bridges cannot bypass per-tool approval', async () => {
    for (const toolName of ['run_tools_with_code', 'run_tools_with_bash']) {
      expect((await check(undefined, { toolName })).decision).toBe('deny');
    }
  });
  test('only raw tool names for the configured server match, and punctuation is literal', () => {
    const p = buildMandatoryApproval(config, true);
    expect(p.matches('create-event_mcp_other')).toBe(false);
    expect(p.matches('prefix_create-event_mcp_office')).toBe(false);
    expect(p.matches('update.v1_mcp_office')).toBe(true);
    expect(p.matches('updateXv1_mcp_office')).toBe(false);
  });
  test('ambiguous delimiter suffixes cannot remove a matching restriction', () => {
    const p = buildMandatoryApproval(
      { ...config, foo_mcp_office: { ...config.office, requireToolApproval: [] } },
      true,
    );
    expect(p.matches('create-event_mcp_foo_mcp_office')).toBe(true);
  });
  test('raw administrator server names map to the same canonical tool names as MCP', () => {
    const p = buildMandatoryApproval({ 'Office Team': config.office }, true);
    expect(p.matches('create-event_mcp_Office_Team')).toBe(true);
    expect(p.matches('create-event_mcp_Office Team')).toBe(true);
    expect(p.matches('create-event_mcp_office_team')).toBe(false);
  });
  test('no configured policy leaves existing behavior unchanged', () => {
    expect(buildMandatoryApproval({}, false).enabled).toBe(false);
  });
  test('an explicit deny still overrides mandatory ask', async () => {
    const registry = new HookRegistry();
    registry.register('PreToolUse', { hooks: [createToolPolicyHook({ deny: ['*'] })] });
    registry.register('PreToolUse', { hooks: [buildMandatoryApproval(config, true).hook] });
    expect((await executeHooks({ registry, input: input() })).decision).toBe('deny');
  });
});

describe('protected MCP endpoint aliases', () => {
  const admin = { office: { url: 'http://office:80/mcp', requireToolApproval: ['create-*'] } };
  test.each([
    'http://OFFICE/mcp',
    'http://office/mcp/',
    'http://office/mcp?x=1',
    'http://office/%6dcp',
  ])('blocks personal or unregistered aliases of %s', (url) => {
    for (const userSourced of [true, false]) {
      expect(
        isProtectedMCPAlias({
          serverName: 'alias',
          serverConfig: { url },
          adminServers: admin,
          userSourced,
        }),
      ).toBe(true);
    }
  });
  test('blocks a user-sourced shadow even with the same name', () => {
    expect(
      isProtectedMCPAlias({
        serverName: 'office',
        serverConfig: admin.office,
        adminServers: admin,
        userSourced: true,
      }),
    ).toBe(true);
  });
  test('allows managed connections and inherits policy on a second managed name', () => {
    const servers = { ...admin, alternate: { url: 'http://office/mcp/' } };
    expect(
      isProtectedMCPAlias({
        serverName: 'alternate',
        serverConfig: servers.alternate,
        adminServers: servers,
        userSourced: false,
      }),
    ).toBe(false);
    expect(buildMandatoryApproval(servers, true).matches('create-event_mcp_alternate')).toBe(true);
  });
  test('does not block unrelated personal endpoints', () => {
    expect(
      isProtectedMCPAlias({
        serverName: 'personal',
        serverConfig: { url: 'https://another.example/mcp' },
        adminServers: admin,
        userSourced: true,
      }),
    ).toBe(false);
  });
});

test('unresolved personal URL cannot be resolved later into a protected endpoint', () => {
  expect(
    isProtectedMCPAlias({
      serverName: 'personal',
      serverConfig: { url: '{{TARGET}}' },
      userSourced: true,
      adminServers: { office: { url: 'http://office/mcp', requireToolApproval: ['*'] } },
    }),
  ).toBe(true);
});
