import { ErrorTypes } from 'librechat-data-provider';

/** Classify runtime signals, never model/tool output that merely mentions a limit. */
export function isAgentBudgetError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }
  const signal = error as { name?: unknown; lc_error_code?: unknown; code?: unknown };
  return (
    signal.name === 'GraphRecursionError' ||
    signal.lc_error_code === 'GRAPH_RECURSION_LIMIT' ||
    signal.code === ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED ||
    signal.code === 'KISUNO_COST_LIMIT' ||
    signal.code === 'KISUNO_WORK_CONTROL_UNAVAILABLE'
  );
}

/** Persist the terminal reason alongside completed parts without replaying the graph. */
export function resolveAgentBudgetError(error: unknown): string | undefined {
  if (!isAgentBudgetError(error)) {
    return undefined;
  }
  if ((error as { code?: string }).code === 'KISUNO_WORK_CONTROL_UNAVAILABLE') {
    return JSON.stringify({
      type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
      status: 'incomplete',
      reason: 'control_unavailable',
    });
  }
  if ((error as { code?: string }).code === 'KISUNO_COST_LIMIT') {
    return JSON.stringify({
      type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
      status: 'incomplete',
      reason: 'cost_limit',
    });
  }
  return JSON.stringify({ type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED, status: 'incomplete' });
}
