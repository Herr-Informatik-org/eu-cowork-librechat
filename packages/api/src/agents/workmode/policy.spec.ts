import { executeHooks } from '@librechat/agents';
import { WORK_MODE_PLAN_MARKER } from 'librechat-data-provider';
import type { PreToolUseHookInput } from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import {
  parseWorkMode,
  decideWorkMode,
  buildWorkModeLayer,
  createWorkModeHook,
  collectRunToolNames,
  resolveWorkModeConfig,
  withWorkModeBaseline,
  createToolRiskClassifier,
  WORK_MODE_PLAN_REASON,
  WORK_MODE_BRIDGE_REASON,
  WORK_MODE_CRITICAL_REASON,
  WORK_MODE_ASK_BRIDGE_REASON,
  WORK_MODE_PLAN_BRIDGE_REASON,
} from './policy';
import { recordToolHints, clearToolHints } from './hints';
import { resolveToolApprovalPolicy, exemptAskUserQuestionFromApproval } from '../hitl/policy';
import { buildHITLRunWiring } from '../hitl/runtime';
import { resolveWorkModeRun } from './run';

const ODOO = '_mcp_odoo-admin';
const SEARCH = `search_records${ODOO}`;
const UPDATE = `update_record${ODOO}`;
const DELETE = `delete_record${ODOO}`;
const BRIDGE = 'run_tools_with_code';

const ENABLED: TToolApprovalPolicy = {
  enabled: true,
  mode: 'bypass',
  workModes: { enabled: true },
};

function preToolUse(toolName: string, agentId?: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    runId: 'run-1',
    toolName,
    toolInput: {},
    toolUseId: `call-${toolName}`,
    ...(agentId != null && { agentId }),
  };
}

/** Folds every PreToolUse hook of the run exactly like the SDK's ToolNode does. */
async function decide(
  requested: unknown,
  toolName: string,
  options: { policy?: TToolApprovalPolicy; agentId?: string } = {},
) {
  const policy = options.policy ?? ENABLED;
  const run = resolveWorkModeRun({
    policy,
    requested,
    hitlCapable: true,
    agents: [{ toolDefinitions: [{ name: SEARCH }, { name: UPDATE }, { name: DELETE }] }],
  });
  const effective = resolveToolApprovalPolicy({
    endpoint: run?.endpoint ?? policy,
    agent: run?.layer,
  });
  const wiring = buildHITLRunWiring(
    exemptAskUserQuestionFromApproval(effective, 'ask_user_question'),
  );
  if (wiring == null) {
    return { decision: undefined, reason: undefined };
  }
  if (run != null) {
    wiring.hooks.register('PreToolUse', { hooks: [run.hook] });
  }
  return executeHooks({
    registry: wiring.hooks,
    input: preToolUse(toolName, options.agentId),
    sessionId: 'run-1',
    matchQuery: toolName,
  });
}

afterEach(() => clearToolHints());

describe('work mode config', () => {
  test('is off unless explicitly enabled, and the endpoint kill switch wins', () => {
    expect(resolveWorkModeConfig(undefined)).toBeUndefined();
    expect(resolveWorkModeConfig({ enabled: true })).toBeUndefined();
    expect(resolveWorkModeConfig({ enabled: false, workModes: { enabled: true } })).toBeUndefined();
    expect(resolveWorkModeConfig({ workModes: { enabled: true } })).toEqual({
      defaultMode: 'auto',
    });
    expect(resolveWorkModeConfig({ workModes: { enabled: true, default: 'ask' } })).toEqual({
      defaultMode: 'ask',
    });
  });

  test('accepts only known modes from the request', () => {
    expect(parseWorkMode('plan', 'auto')).toBe('plan');
    expect(parseWorkMode('bypass', 'auto')).toBe('auto');
    expect(parseWorkMode({ mode: 'plan' }, 'ask')).toBe('ask');
    expect(parseWorkMode(undefined, 'ask')).toBe('ask');
  });

  test('baseline enables HITL without loosening an explicit admin mode', () => {
    expect(withWorkModeBaseline(undefined)).toEqual({ enabled: true, mode: 'bypass' });
    expect(withWorkModeBaseline({ mode: 'default', ask: ['x'] })).toEqual({
      enabled: true,
      mode: 'default',
      ask: ['x'],
    });
    const enabled: TToolApprovalPolicy = { enabled: true, mode: 'default' };
    expect(withWorkModeBaseline(enabled)).toBe(enabled);
  });
});

describe('decideWorkMode', () => {
  test('follows the plan / ask / auto table', () => {
    expect(decideWorkMode('plan', 'read')).toBe('allow');
    expect(decideWorkMode('plan', 'write')).toBe('deny');
    expect(decideWorkMode('plan', 'critical')).toBe('deny');
    expect(decideWorkMode('ask', 'read')).toBe('allow');
    expect(decideWorkMode('ask', 'write')).toBe('ask');
    expect(decideWorkMode('ask', 'critical')).toBe('ask');
    expect(decideWorkMode('auto', 'read')).toBe('allow');
    expect(decideWorkMode('auto', 'write')).toBe('allow');
    expect(decideWorkMode('auto', 'critical')).toBe('ask');
  });
});

describe('work mode layer and hook', () => {
  test('collects tool names from every surface once', () => {
    const names = collectRunToolNames([
      {
        tools: [{ name: 'a' }, {}],
        toolDefinitions: [{ name: 'b' }, { name: 'a' }],
        toolRegistry: new Map([['c', {}]]),
      },
    ]);
    expect([...names].sort()).toEqual(['a', 'b', 'c']);
  });

  test('the layer only allows what the mode lets run alone, and only over bypass', () => {
    const classify = createToolRiskClassifier();
    const names = [SEARCH, UPDATE, DELETE, 'weird*name'];
    expect(buildWorkModeLayer('plan', names, classify, 'bypass')).toEqual({ allow: [SEARCH] });
    expect(buildWorkModeLayer('ask', names, classify, 'bypass')).toEqual({ allow: [SEARCH] });
    expect(buildWorkModeLayer('auto', names, classify, 'bypass')).toEqual({
      allow: [SEARCH, UPDATE],
    });
    expect(buildWorkModeLayer('plan', [UPDATE], classify, 'bypass')).toEqual({});
    expect(buildWorkModeLayer('auto', names, classify, 'default')).toEqual({});
    expect(buildWorkModeLayer('auto', names, classify, 'dontAsk')).toEqual({});
    expect(buildWorkModeLayer('auto', names, classify, undefined)).toEqual({});
  });

  test('administrators may additionally edit the proposed arguments', async () => {
    const hook = createWorkModeHook('ask', createToolRiskClassifier(), { allowEdit: true });
    await expect(hook(preToolUse(UPDATE), new AbortController().signal)).resolves.toMatchObject({
      allowedDecisions: ['approve', 'reject', 'edit'],
    });
  });

  test('the hook asks with approve/reject only and denies inside subagents', async () => {
    const hook = createWorkModeHook('ask', createToolRiskClassifier());
    const signal = new AbortController().signal;
    await expect(hook(preToolUse(SEARCH), signal)).resolves.toEqual({});
    await expect(hook(preToolUse(UPDATE), signal)).resolves.toMatchObject({
      decision: 'ask',
      allowedDecisions: ['approve', 'reject'],
    });
    await expect(hook(preToolUse(UPDATE, 'child'), signal)).resolves.toMatchObject({
      decision: 'deny',
    });
  });
});

describe('server enforcement through the SDK hook fold', () => {
  test('plan blocks every write, even with an admin bypass baseline', async () => {
    await expect(decide('plan', SEARCH)).resolves.toMatchObject({ decision: 'allow' });
    const update = await decide('plan', UPDATE);
    expect(update.decision).toBe('deny');
    expect(update.reason).toBe(WORK_MODE_PLAN_REASON);
    expect(update.reason?.startsWith(WORK_MODE_PLAN_MARKER)).toBe(true);
    await expect(decide('plan', DELETE)).resolves.toMatchObject({ decision: 'deny' });
    await expect(decide('plan', 'brand_new_tool_mcp_x')).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  test('ask pauses every write, auto only the critical ones', async () => {
    await expect(decide('ask', UPDATE)).resolves.toMatchObject({ decision: 'ask' });
    await expect(decide('auto', UPDATE)).resolves.toMatchObject({ decision: 'allow' });
    const remove = await decide('auto', DELETE);
    expect(remove.decision).toBe('ask');
    expect(remove.reason).toBe(WORK_MODE_CRITICAL_REASON);
  });

  test('a manipulated mode falls back to the configured default instead of loosening', async () => {
    const policy: TToolApprovalPolicy = {
      ...ENABLED,
      workModes: { enabled: true, default: 'plan' },
    };
    await expect(decide('bypass', UPDATE, { policy })).resolves.toMatchObject({ decision: 'deny' });
    await expect(decide(['auto'], UPDATE, { policy })).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  test('bypass + auto: reads and routine writes run, critical asks', async () => {
    await expect(decide('auto', SEARCH)).resolves.toMatchObject({ decision: 'allow' });
    await expect(decide('auto', UPDATE)).resolves.toMatchObject({ decision: 'allow' });
    await expect(decide('auto', DELETE)).resolves.toMatchObject({ decision: 'ask' });
  });

  test('default + auto: the admin baseline keeps asking, the mode never loosens it', async () => {
    const policy: TToolApprovalPolicy = {
      enabled: true,
      mode: 'default',
      workModes: { enabled: true },
    };
    await expect(decide('auto', SEARCH, { policy })).resolves.toMatchObject({ decision: 'ask' });
    await expect(decide('auto', UPDATE, { policy })).resolves.toMatchObject({ decision: 'ask' });
    await expect(decide('auto', DELETE, { policy })).resolves.toMatchObject({ decision: 'ask' });
  });

  test('dontAsk + auto: the admin baseline keeps denying unlisted tools', async () => {
    const policy: TToolApprovalPolicy = {
      enabled: true,
      mode: 'dontAsk',
      allow: [SEARCH],
      workModes: { enabled: true },
    };
    await expect(decide('auto', SEARCH, { policy })).resolves.toMatchObject({ decision: 'allow' });
    await expect(decide('auto', UPDATE, { policy })).resolves.toMatchObject({ decision: 'deny' });
    await expect(decide('auto', DELETE, { policy })).resolves.toMatchObject({ decision: 'deny' });
  });

  test('batch bridges: blocked in plan and ask, a critical card in auto', async () => {
    const plan = await decide('plan', BRIDGE);
    expect(plan).toMatchObject({ decision: 'deny', reason: WORK_MODE_PLAN_BRIDGE_REASON });
    expect(plan.reason?.startsWith(WORK_MODE_PLAN_MARKER)).toBe(true);
    await expect(decide('ask', BRIDGE)).resolves.toMatchObject({
      decision: 'deny',
      reason: WORK_MODE_ASK_BRIDGE_REASON,
    });
    await expect(decide('auto', BRIDGE)).resolves.toMatchObject({
      decision: 'ask',
      reason: WORK_MODE_BRIDGE_REASON,
    });
  });

  test('admin ask and deny lists keep winning over the mode layer', async () => {
    const policy: TToolApprovalPolicy = {
      ...ENABLED,
      ask: [SEARCH],
      deny: [UPDATE],
    };
    await expect(decide('auto', SEARCH, { policy })).resolves.toMatchObject({ decision: 'ask' });
    await expect(decide('auto', UPDATE, { policy })).resolves.toMatchObject({ decision: 'deny' });
  });

  test('a subagent write in mode ask is denied instead of asking', async () => {
    await expect(decide('ask', UPDATE, { agentId: 'child' })).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  test('MCP annotations reclassify an unmatched tool for its own user only', async () => {
    recordToolHints('crm', [{ name: 'partner_feed', annotations: { readOnlyHint: true } }], 'u1');
    expect(createToolRiskClassifier('u1')('partner_feed_mcp_crm')).toBe('read');
    expect(createToolRiskClassifier('u2')('partner_feed_mcp_crm')).toBe('write');
  });

  test('readOnlyHint never downgrades a name that writes', async () => {
    recordToolHints('crm', [{ name: 'sync_partners', annotations: { readOnlyHint: true } }]);
    expect(createToolRiskClassifier()('sync_partners_mcp_crm')).toBe('write');
  });

  test('is inactive for callers without an approval surface or with the feature off', () => {
    const agents = [{ toolDefinitions: [{ name: UPDATE }] }];
    expect(
      resolveWorkModeRun({ policy: ENABLED, requested: 'plan', hitlCapable: false, agents }),
    ).toBeUndefined();
    expect(
      resolveWorkModeRun({
        policy: { enabled: true },
        requested: 'plan',
        hitlCapable: true,
        agents,
      }),
    ).toBeUndefined();
  });
});
