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
    signal.code === ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED
  );
}

/** Persist the terminal reason alongside completed parts without replaying the graph. */
export function resolveAgentBudgetError(error: unknown): string | undefined {
  if (!isAgentBudgetError(error)) {
    return undefined;
  }
  return JSON.stringify({ type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED, status: 'incomplete' });
}
