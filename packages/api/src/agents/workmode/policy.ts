import {
  workModeSchema,
  classifyToolRisk,
  WORK_MODE_PLAN_MARKER,
  isProgrammaticBridgeTool,
} from 'librechat-data-provider';
import type {
  ToolRisk,
  WorkMode,
  ToolApprovalMode,
  TToolApprovalPolicy,
} from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import { getToolHints } from './hints';

/** Server fallback when the request carries no valid mode. */
export const DEFAULT_WORK_MODE: WorkMode = 'auto';

export type WorkModeDecision = 'allow' | 'ask' | 'deny';

/** Effective work-mode setting of the agents endpoint, or undefined when switched off. */
export interface WorkModeConfig {
  defaultMode: WorkMode;
}

/** Block reason for writes in plan mode; read by the model and recognized by the card. */
export const WORK_MODE_PLAN_REASON: string = `${WORK_MODE_PLAN_MARKER}: Diese Änderung wurde nicht ausgeführt. Beschreiben Sie sie als Planschritt mit Ziel und Werten. Die Person entscheidet danach, ob sie ausgeführt wird.`;

/** Card description for a routine write in mode `ask`. */
export const WORK_MODE_WRITE_REASON =
  'Dieser Schritt ändert Daten. Bitte prüfen Sie Ziel und Werte.';

/** Card description for deleting, sending or executing. */
export const WORK_MODE_CRITICAL_REASON =
  'Dieser Schritt löscht, sendet oder führt etwas aus. Bitte prüfen Sie Ziel und Werte genau.';

/** Card description for code that runs in the isolated sandbox. */
export const WORK_MODE_CODE_REASON =
  'Dieser Schritt führt Code in der abgeschotteten Umgebung aus. Bitte prüfen Sie den Code.';

/** Card description for a batch bridge in mode `auto`: its inner calls are not confirmed one by one. */
export const WORK_MODE_BRIDGE_REASON =
  'Dieser Schritt ruft per Code mehrere Werkzeuge gesammelt auf. Einzelne Änderungen darin werden nicht mehr bestätigt. Bitte prüfen Sie den Code genau.';

/** Plan mode blocks batch bridges; the model is told to call tools one by one. */
export const WORK_MODE_PLAN_BRIDGE_REASON: string = `${WORK_MODE_PLAN_MARKER}: Sammelaufrufe per Code sind gesperrt. Rufen Sie lesende Werkzeuge einzeln auf und beschreiben Sie Änderungen als Planschritte.`;

/** Ask mode blocks batch bridges: each change needs its own card. */
export const WORK_MODE_ASK_BRIDGE_REASON =
  'Arbeitsmodus Fragen: Sammelaufrufe per Code sind gesperrt, weil jede Änderung einzeln bestätigt wird. Rufen Sie die Werkzeuge einzeln auf.';

const CODE_TOOLS: ReadonlySet<string> = new Set(['execute_code', 'bash_tool']);

function askReason(toolName: string, risk: ToolRisk): string {
  if (isProgrammaticBridgeTool(toolName)) {
    return WORK_MODE_BRIDGE_REASON;
  }
  if (CODE_TOOLS.has(toolName)) {
    return WORK_MODE_CODE_REASON;
  }
  return risk === 'critical' ? WORK_MODE_CRITICAL_REASON : WORK_MODE_WRITE_REASON;
}

/** Subagent graphs run without a checkpointer and can never show a card. */
export const WORK_MODE_SUBAGENT_REASON =
  'Diese Änderung braucht eine Bestätigung im Webchat und ist in einem Unteragenten gesperrt.';

/**
 * Reads `endpoints.agents.toolApproval.workModes`. The endpoint's explicit
 * `enabled: false` stays the kill switch for every approval feature.
 */
export function resolveWorkModeConfig(
  policy: TToolApprovalPolicy | undefined,
): WorkModeConfig | undefined {
  if (policy?.workModes?.enabled !== true || policy.enabled === false) {
    return undefined;
  }
  return { defaultMode: policy.workModes.default ?? DEFAULT_WORK_MODE };
}

/** Accepts only a known mode from the untrusted request body. */
export function parseWorkMode(value: unknown, fallback: WorkMode): WorkMode {
  const parsed = workModeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** The policy table: reads always run; `plan` blocks writes; `ask` asks for all; `auto` only for critical. */
export function decideWorkMode(mode: WorkMode, risk: ToolRisk): WorkModeDecision {
  if (risk === 'read') {
    return 'allow';
  }
  if (mode === 'plan') {
    return 'deny';
  }
  if (mode === 'ask') {
    return 'ask';
  }
  return risk === 'critical' ? 'ask' : 'allow';
}

/** Risk of a tool for one user, using that user's MCP annotations when known. */
export function createToolRiskClassifier(userId?: string): (toolName: string) => ToolRisk {
  return (toolName) => classifyToolRisk(toolName, getToolHints(toolName, userId));
}

interface ToolSurface {
  tools?: unknown[];
  toolRegistry?: Map<string, unknown>;
  toolDefinitions?: Array<{ name: string }>;
}

/** Every tool name a run can call directly, collected in one pass over each surface. */
export function collectRunToolNames(agents: ReadonlyArray<ToolSurface>): Set<string> {
  const names = new Set<string>();
  for (const agent of agents) {
    for (const tool of agent.tools ?? []) {
      const name = (tool as { name?: unknown } | undefined)?.name;
      if (typeof name === 'string' && name.length > 0) {
        names.add(name);
      }
    }
    for (const def of agent.toolDefinitions ?? []) {
      names.add(def.name);
    }
    for (const name of agent.toolRegistry?.keys() ?? []) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The per-request `agent` layer of the approval policy. It only ever ALLOWS the
 * tools the mode lets run on their own, and only over a `bypass` baseline: the
 * SDK evaluates deny, ask, allow, then the mode fallback, so an exact `allow`
 * would beat an admin's `dontAsk` or `default`. Over those baselines the layer
 * stays empty and the mode is enforced by {@link createWorkModeHook} alone,
 * which can only tighten. An admin's `deny` or `ask` always wins.
 */
export function buildWorkModeLayer(
  mode: WorkMode,
  toolNames: Iterable<string>,
  classify: (toolName: string) => ToolRisk,
  baselineMode: ToolApprovalMode | undefined,
): TToolApprovalPolicy {
  if (baselineMode !== 'bypass') {
    return {};
  }
  const allow: string[] = [];
  for (const name of toolNames) {
    if (name.includes('*')) {
      continue;
    }
    if (decideWorkMode(mode, classify(name)) === 'allow') {
      allow.push(name);
    }
  }
  return allow.length > 0 ? { allow } : {};
}

/** Decisions a proposal card may send; editing arguments is reserved for administrators. */
export function getWorkModeDecisions(allowEdit: boolean): Array<'approve' | 'reject' | 'edit'> {
  return allowEdit ? ['approve', 'reject', 'edit'] : ['approve', 'reject'];
}

/**
 * `PreToolUse` hook enforcing the mode for every call, independent of what the
 * client shows. It can only tighten (the SDK folds `deny > ask > allow`), and in a
 * subagent scope an `ask` becomes `deny` because no card can render there.
 */
export function createWorkModeHook(
  mode: WorkMode,
  classify: (toolName: string) => ToolRisk,
  options: { allowEdit?: boolean } = {},
): HookCallback<'PreToolUse'> {
  const allowedDecisions = getWorkModeDecisions(options.allowEdit === true);
  return async (input) => {
    if (isProgrammaticBridgeTool(input.toolName) && mode !== 'auto') {
      return {
        decision: 'deny',
        reason: mode === 'plan' ? WORK_MODE_PLAN_BRIDGE_REASON : WORK_MODE_ASK_BRIDGE_REASON,
      };
    }
    const risk = classify(input.toolName);
    const decision = decideWorkMode(mode, risk);
    if (decision === 'allow') {
      return {};
    }
    if (decision === 'deny') {
      return { decision: 'deny', reason: WORK_MODE_PLAN_REASON };
    }
    if (input.agentId != null) {
      return { decision: 'deny', reason: WORK_MODE_SUBAGENT_REASON };
    }
    return {
      decision: 'ask',
      reason: askReason(input.toolName, risk),
      allowedDecisions,
    };
  };
}

/** Lifts the endpoint policy to an enabled baseline that lets unlisted tools run; the hook tightens. */
export function withWorkModeBaseline(
  policy: TToolApprovalPolicy | undefined,
): NonNullable<TToolApprovalPolicy> {
  if (policy?.enabled === true) {
    return policy;
  }
  return { ...policy, enabled: true, mode: policy?.mode ?? 'bypass' };
}
