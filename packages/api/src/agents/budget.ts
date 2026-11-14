import type { HookCallback, HookRegistry } from '@librechat/agents';
import type { SafeWorkScope } from './safeWork';
import { isSafeWorkEnabled, SAFE_WORK_MAX_MS } from './safeWork';

const MIN_PROACTIVE_LIMIT = 12;
const FINALIZATION_RESERVE = 6;
const exhaustedRuns = new WeakMap<object, AgentWorkBudget>();
const boundedRuns = new Map<string, AgentWorkBudget>();

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
  /** The closing guidance was given: the run should wrap up, not start new work. */
  closing: boolean;
  reset?: () => boolean;
  segment: number;
  deadline?: number;
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
  freeClosure?: boolean;
  closureScope?: SafeWorkScope;
  /** Read the SDK's model-node metadata, never a tool-call count. */
  readModelStep: () => number | undefined;
}

/** The weak association survives SDK cleanup without retaining completed runs. */
export function hasAgentWorkBudgetExhausted(run: object | undefined): boolean {
  return run != null && exhaustedRuns.get(run)?.exhausted === true;
}

/** True once the run was told to wrap up or was stopped; a host must not start another pass. */
export function isAgentWorkBudgetClosing(run: object | undefined): boolean {
  const state = run != null ? exhaustedRuns.get(run) : undefined;
  return state?.exhausted === true || state?.closing === true;
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
  const closureKey = options.closureScope && budgetScopeKey(options.closureScope);
  const freeClosure =
    options.freeClosure === true &&
    isSafeWorkEnabled() &&
    closureKey != null &&
    options.closureScope?.taskId === runId;
  if (!Number.isSafeInteger(limit) || limit < MIN_PROACTIVE_LIMIT) {
    return undefined;
  }
  const state: AgentWorkBudget = { exhausted: false, closing: false, segment: 1 };
  if (freeClosure) {
    // Only expired sections may be evicted; an active section must keep its closing guard.
    for (const [key, previous] of boundedRuns) {
      if (previous.deadline && Date.now() > previous.deadline + SAFE_WORK_MAX_MS) {
        boundedRuns.delete(key);
      }
    }
    boundedRuns.set(closureKey!, state);
  }
  const warningAt = Math.floor(limit * 0.8);
  const denyAt = limit - FINALIZATION_RESERVE;
  let origin: number | undefined = resumed ? undefined : 0;
  /** Steps of earlier passes on this run; a follow-up pass restarts the SDK step counter. */
  let carried = 0;
  let lastStep: number | undefined;
  let warned = false;
  let firstDeniedStep: number | undefined;
  const deadline = Date.now() + SAFE_WORK_MAX_MS;
  state.deadline = deadline;

  state.reset = () => {
    if (state.exhausted || !state.closing || state.segment >= 3) return false;
    state.closing = false;
    state.segment++;
    origin = undefined;
    carried = 0;
    lastStep = undefined;
    warned = false;
    firstDeniedStep = undefined;
    return true;
  };

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
    if (lastStep !== undefined && step < lastStep) {
      carried += lastStep - origin;
      origin = step - 1;
    }
    lastStep = step;
    return step >= origin ? carried + step - origin : undefined;
  };

  const guard: HookCallback<'PreToolUse'> = async (input) => {
    if (!owns(input)) {
      return {};
    }
    if (isSafeWorkEnabled() && Date.now() >= deadline) {
      state.closing = true;
      state.exhausted = true;
      return {
        decision: 'deny',
        // The guarded transport ends the next model node naturally, after the tool batch settles.
        additionalContext: 'Die Laufzeitgrenze ist erreicht. Beende diesen Abschnitt.',
        ...(!freeClosure && {
          preventContinuation: true,
          stopReason: 'safe_work_time_limit',
        }),
        reason:
          'Die aktive Laufzeitgrenze ist erreicht. Es werden keine neuen Änderungen begonnen.',
      };
    }
    if (state.segment > 1 && !isSafeContinuationTool(input.toolName)) {
      state.exhausted = true;
      return {
        decision: 'deny',
        ...(!freeClosure && {
          preventContinuation: true,
          stopReason: 'safe_work_review_required',
        }),
        reason:
          'Dieses Werkzeug darf nicht automatisch fortgesetzt werden. Der Auftrag bleibt für eine persönliche Prüfung angehalten.',
      };
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
        state.closing = true;
        return {
          additionalContext: isSafeWorkEnabled()
            ? 'Die Abschnittsgrenze nähert sich. Beende die laufende Einzelprüfung vollständig und nenne den bestätigten Zwischenstand mit offenen Schritten. Der Server entscheidet über eine kontrollierte Fortsetzung. Bereits bestätigte Schreibaktionen nicht erneut ausführen.'
            : CLOSING_GUIDANCE,
        };
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
      ...(finish &&
        !freeClosure && {
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

/** Only a completed soft-budget boundary may start a fresh bounded section. */
export function resetAgentWorkBudget(run: object): boolean {
  return exhaustedRuns.get(run)?.reset?.() ?? false;
}
/** This is a narrow continuation allowlist, never a replacement for MCP authorization. */
export function isSafeContinuationTool(name: string): boolean {
  return (
    [
      'plan_aktualisieren',
      'brain_search',
      'brain_context',
      'skill',
      'read_file',
      'file_search',
      'arbeitsdaten_lesen',
      'arbeitsstand_sichern',
    ].includes(name) ||
    /^(get_record|search_records|list_models|list_resource_templates|aggregate_records|update_record)_mcp_odoo(?:-|$)/i.test(
      name,
    )
  );
}

/** Return a deterministic, free final turn instead of cancelling a live SDK iterator. */
function budgetScopeKey(scope: SafeWorkScope): string | undefined {
  if (!scope.userId || !scope.conversationId || !scope.taskId) return;
  return JSON.stringify([
    scope.tenantId || 'cw01',
    scope.userId,
    scope.conversationId,
    scope.taskId,
  ]);
}

export function workBudgetClosure(scope: SafeWorkScope): string | undefined {
  if (!isSafeWorkEnabled()) return;
  const key = budgetScopeKey(scope);
  const state = key && boundedRuns.get(key);
  if (!state) return;
  if (state.deadline && Date.now() >= state.deadline) {
    state.exhausted = true;
    state.closing = true;
  }
  if (!state.exhausted) return;
  return 'Dieser Arbeitsabschnitt ist an seiner sicheren Grenze pausiert. Bereits bestätigte Einzeländerungen bleiben erhalten. Offene Schritte sind noch nicht abgeschlossen; sie dürfen nur anhand des gespeicherten Arbeitsstands fortgesetzt werden.';
}
