import type { HookCallback, HookRegistry } from '@librechat/agents';

const MIN_PROACTIVE_LIMIT = 12;
const FINALIZATION_RESERVE = 6;
const exhaustedRuns = new WeakMap<object, AgentWorkBudget>();

const PLANNING_GUIDANCE =
  'Plane die Werkzeugarbeit innerhalb eines begrenzten Laufs. Prüfe zuerst das tatsächliche Schema ' +
  'und deine Berechtigungen. Ermittle die benötigten IDs und lies zugehörige Datensätze über die ' +
  'unterstützten gefilterten, gebündelten und paginierten Abfragen. Wähle gezielte Felder, ohne ' +
  'vom Nutzer verlangte Informationen wegzulassen. Verwende bereits bestätigte Ergebnisse und ' +
  'Dateireferenzen weiter, statt unveränderte Daten erneut zu lesen oder Codeversuche ohne neue ' +
  'Erkenntnis zu wiederholen. Dokumentiere bei Exporten die abgedeckten Bereiche und fehlende, ' +
  'nicht berechtigte oder noch nicht vollständig geladene Daten. Erfinde keine Summen oder ' +
  'Bearbeitungszeiten. Dieser Hinweis erteilt keine zusätzlichen Schreibrechte. Wiederhole keine ' +
  'schreibende Aktion aufgrund eines unklaren Ergebnisses. Melde bei einem unvollständigen Auftrag ' +
  'ausdrücklich, welche Ergebnisse bestätigt sind und welche Arbeit noch offen ist.';

const CLOSING_GUIDANCE =
  'Das Arbeitsbudget dieses Laufs ist beinahe aufgebraucht. Schliesse den Auftrag jetzt anhand ' +
  'der bereits bestätigten Ergebnisse ab. Starte keine neue Recherche oder Reparaturschleife. ' +
  'Nenne vorhandene Dateien und bestätigte Resultate, sowie ausdrücklich noch offene Schritte. ' +
  'Behaupte keine Vollständigkeit, wenn Daten oder die fertige Exportdatei fehlen.';

const TOOL_LIMIT_GUIDANCE =
  'Das Werkzeugbudget ist aufgebraucht. Dieser Werkzeugaufruf wurde nicht ausgeführt. ' +
  'Führe keine weiteren Werkzeuge aus. Antworte jetzt mit den bereits bestätigten Ergebnissen ' +
  'und nenne ausdrücklich, was noch fehlt. Eine neue Nachricht kann die offene Arbeit fortsetzen; ' +
  'bereits ausgeführte Schreibaktionen dürfen dabei nicht automatisch wiederholt werden.';

interface AgentWorkBudget {
  exhausted: boolean;
}

interface BudgetHookScope {
  runId: string;
  agentId?: string;
  executingAgentId?: string;
}

export interface AgentWorkBudgetOptions {
  registry: HookRegistry;
  runId: string;
  agentId: string;
  limit: number;
  resumed?: boolean;
  /** Read the SDK's model-node metadata, never a tool-call count. */
  readModelStep: () => number | undefined;
}

/** The weak association survives SDK cleanup without retaining completed runs. */
export function hasAgentWorkBudgetExhausted(run: object | undefined): boolean {
  return run != null && exhaustedRuns.get(run)?.exhausted === true;
}

/**
 * Applies only to a single agent graph. Its public `config`
 * snapshot belongs to one model node; a multi-agent graph shares that mutable
 * field across siblings and must keep using the hard graph cap instead.
 */
export function installAgentWorkBudget(
  options: AgentWorkBudgetOptions,
): ((run: object) => void) | undefined {
  const { registry, runId, agentId, limit, resumed, readModelStep } = options;
  if (!Number.isSafeInteger(limit) || limit < MIN_PROACTIVE_LIMIT) {
    return undefined;
  }
  const state: AgentWorkBudget = { exhausted: false };
  const warningAt = Math.floor(limit * 0.8);
  const denyAt = limit - FINALIZATION_RESERVE;
  let origin: number | undefined = resumed ? undefined : 0;
  let warned = false;
  let firstDeniedStep: number | undefined;

  const owns = (input: BudgetHookScope): boolean =>
    input.runId === runId && input.agentId == null && input.executingAgentId === agentId;

  const usedSteps = (): number | undefined => {
    const step = readModelStep();
    if (!Number.isSafeInteger(step) || step == null || step < 1) {
      return undefined;
    }
    // Resume starts a new invocation budget at the saved step, not at zero.
    // Its first tool boundary follows the first observed model step. Any
    // earlier compaction remains bounded by LangGraph's unchanged hard cap.
    origin ??= step - 1;
    return step >= origin ? step - origin : undefined;
  };

  const guard: HookCallback<'PreToolUse'> = async (input) => {
    if (!owns(input)) {
      return {};
    }
    const step = usedSteps();
    // A resumed pending ToolNode may run before the rebuilt graph has any
    // model metadata. Preserve its existing approval gate and hard limit.
    if (!warned && !state.exhausted && step == null) {
      return {};
    }
    if (!state.exhausted && step != null && step < denyAt) {
      if (!warned && step >= Math.min(warningAt, denyAt - 2)) {
        warned = true;
        return { additionalContext: CLOSING_GUIDANCE };
      }
      return {};
    }
    // Once armed, missing metadata must not reopen execution. All parallel
    // calls in the same batch see the same latch and are denied together.
    state.exhausted = true;
    firstDeniedStep ??= step;
    const finish = step != null && firstDeniedStep != null && step > firstDeniedStep;
    return {
      decision: 'deny',
      reason: TOOL_LIMIT_GUIDANCE,
      ...(finish && {
        // A later MODEL step proves all earlier allowed calls settled. This
        // entire batch is denied; no real write can be interrupted by halt.
        preventContinuation: true,
        stopReason: 'agent_work_budget_exceeded',
      }),
    };
  };

  registry.register('RunStart', {
    hooks: [
      async (input) => (input.runId === runId ? { additionalContext: PLANNING_GUIDANCE } : {}),
    ],
  });
  // The SDK's direct tools do not emit PostToolBatch. PreToolUse covers both
  // execution paths and disables speculative eager execution from the first
  // round, so no side effect can bypass this boundary during streaming.
  registry.register('PreToolUse', { hooks: [guard] });

  return (run): void => {
    exhaustedRuns.set(run, state);
  };
}
