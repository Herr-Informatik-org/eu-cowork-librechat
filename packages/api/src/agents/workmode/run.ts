import type { TToolApprovalPolicy, WorkMode } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import {
  parseWorkMode,
  buildWorkModeLayer,
  createWorkModeHook,
  collectRunToolNames,
  resolveWorkModeConfig,
  withWorkModeBaseline,
  createToolRiskClassifier,
} from './policy';

export interface WorkModeRun {
  mode: WorkMode;
  /** Endpoint baseline with HITL enabled, so `ask` can pause the run. */
  endpoint: NonNullable<TToolApprovalPolicy>;
  /** The `agent` layer for {@link resolveToolApprovalPolicy}. */
  layer: TToolApprovalPolicy;
  /** `PreToolUse` enforcement for every call of this run. */
  hook: HookCallback<'PreToolUse'>;
}

/**
 * Everything `createRun` needs for the work mode of one request, or undefined
 * when the feature is off or the caller has no approval surface (OpenAI-compatible
 * and Responses routes never get a mode). Top-level agents and their subagent
 * configs contribute tool names; subagent calls are still covered by the hook.
 */
export function resolveWorkModeRun(params: {
  policy: TToolApprovalPolicy | undefined;
  requested: unknown;
  hitlCapable: boolean;
  agents: ReadonlyArray<{
    tools?: unknown[];
    toolRegistry?: Map<string, unknown>;
    toolDefinitions?: Array<{ name: string }>;
  }>;
  userId?: string;
  /** Administrators may edit arguments on the card; the resume route enforces the list. */
  allowEdit?: boolean;
}): WorkModeRun | undefined {
  const { policy, requested, hitlCapable, agents, userId, allowEdit = false } = params;
  if (!hitlCapable) {
    return undefined;
  }
  const config = resolveWorkModeConfig(policy);
  if (config == null) {
    return undefined;
  }
  const mode = parseWorkMode(requested, config.defaultMode);
  const classify = createToolRiskClassifier(userId);
  return {
    mode,
    endpoint: withWorkModeBaseline(policy),
    layer: buildWorkModeLayer(mode, collectRunToolNames(agents), classify),
    hook: createWorkModeHook(mode, classify, { allowEdit }),
  };
}
