import { hasIncompleteWorkSources } from '../workspace';
import { logger } from '@librechat/data-schemas';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { findLatestPlan, hasOpenPlanSteps } from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { EventStreamOptions, RunStreamConfig } from '@librechat/agents';
import type { PlanSourcePart, TPlan } from 'librechat-data-provider';
import { isAgentWorkBudgetClosing, resetAgentWorkBudget, isSafeContinuationTool } from '../budget';
import {
  isSafeWorkEnabled,
  saveSafeWorkTask,
  hasUncertainSafeWork,
  SAFE_WORK_MAX_SEGMENTS,
  SAFE_WORK_MAX_MS,
} from '../safeWork';
import type { SafeWorkScope } from '../safeWork';

/** The run surface the stop reminder needs; structural so tests can drive it without a model. */
export interface PlanReminderRun {
  processStream(
    inputs: { messages: BaseMessage[] },
    config: RunStreamConfig,
    streamOptions?: EventStreamOptions,
  ): Promise<unknown>;
  getInterrupt(): unknown;
  getHaltReason(): string | undefined;
  getRunMessages(): BaseMessage[] | undefined;
  graphRunnable?: {
    getState(config: RunStreamConfig): Promise<{ values?: { messages?: BaseMessage[] } }>;
  };
}

export interface ContinueOpenPlanParams {
  run: PlanReminderRun;
  /** The input history of the finished pass. */
  messages: BaseMessage[];
  config: RunStreamConfig;
  streamOptions?: EventStreamOptions;
  /** Aggregated content of this turn, where the latest plan lives. */
  contentParts: ReadonlyArray<PlanSourcePart | null | undefined> | null | undefined;
  /**
   * Shared content-index shift of the run's handlers (the steer offset). The
   * SDK numbers a new pass from 0 again, so the shift moves it past the
   * content the finished pass already produced.
   */
  indexOffset?: { offset: number };
  signal?: AbortSignal;
  safeWork?: SafeWorkScope;
}

/** Internal note the model receives once per turn when it stops with open plan steps. */
export function buildPlanReminder(plan: TPlan): string {
  const open = plan.steps
    .filter((step) => step.status !== 'erledigt')
    .map((step) => `- ${step.text}`)
    .join('\n');
  return [
    '<system-hinweis>',
    'Dein Plan enthält noch offene Schritte:',
    open,
    'Arbeite sie jetzt ab und führe den Plan mit plan_aktualisieren nach, oder erkläre der Person kurz, warum du hier aufhörst. Antworte weiter in der Sprache der Person.',
    '</system-hinweis>',
  ].join('\n');
}

/**
 * Messages that must precede the reminder in the next pass. Without stored
 * state the history is replayed with the finished pass appended; when the
 * checkpointer kept the finished pass, only the reminder is new. Any other
 * stored state is treated as unsafe (it could duplicate or lose turns).
 */
async function resolveHistory(
  run: PlanReminderRun,
  config: RunStreamConfig,
  messages: BaseMessage[],
  runMessages: BaseMessage[],
  strict = false,
): Promise<BaseMessage[] | null> {
  let saved: BaseMessage[] = [];
  try {
    const state = await run.graphRunnable?.getState(config);
    saved = Array.isArray(state?.values?.messages) ? state.values.messages : [];
  } catch {
    if (strict) return null;
    saved = [];
  }
  if (saved.length === 0) {
    return [...messages, ...runMessages];
  }
  const lastSaved = saved[saved.length - 1]?.id;
  const lastRun = runMessages[runMessages.length - 1]?.id;
  if (lastSaved != null && lastSaved === lastRun) {
    return [];
  }
  return null;
}

/**
 * Stop reminder: when a finished pass leaves plan steps open, run one more pass
 * with a short note, so multi-step work is completed or its stop explained.
 * Called at most once per turn by the host; skipped on pause, halt, abort or once the
 * work budget asked the run to wrap up, so the reminder never reopens a closed budget.
 * Returns whether a continuation pass ran.
 */
export async function continueOpenPlan({
  run,
  messages,
  config,
  streamOptions,
  contentParts,
  indexOffset,
  signal,
  safeWork,
}: ContinueOpenPlanParams): Promise<boolean> {
  if (safeWork && isSafeWorkEnabled()) {
    return continueSafePlan({
      run,
      messages,
      config,
      streamOptions,
      contentParts,
      indexOffset,
      signal,
      safeWork,
    });
  }
  if (
    signal?.aborted === true ||
    run.getInterrupt() != null ||
    run.getHaltReason() != null ||
    isAgentWorkBudgetClosing(run)
  ) {
    return false;
  }
  const plan = findLatestPlan(contentParts);
  if (!plan || !hasOpenPlanSteps(plan)) {
    return false;
  }
  const runMessages = run.getRunMessages() ?? [];
  if (runMessages.length === 0) {
    return false;
  }
  const history = await resolveHistory(run, config, messages, runMessages);
  if (history == null) {
    logger.warn('[plan] Stored run state does not match the finished pass; reminder skipped');
    return false;
  }
  if (indexOffset) {
    indexOffset.offset = Math.max(indexOffset.offset, contentParts?.length ?? 0);
  }
  logger.debug('[plan] Open plan steps at stop; running one reminder pass', {
    open: plan.steps.filter((step) => step.status !== 'erledigt').length,
    replayed: history.length,
  });
  await run.processStream(
    { messages: [...history, new HumanMessage(buildPlanReminder(plan))] },
    config,
    { ...streamOptions, keepContent: true },
  );
  return true;
}

export type SafeWorkPauseReason =
  | 'section_limit'
  | 'time_limit'
  | 'uncertain_write'
  | 'review_required'
  | 'history_mismatch'
  | 'progress_unavailable';
const pausedRuns = new WeakMap<object, SafeWorkPauseReason>();
export const getSafeWorkPauseReason = (run: object | undefined): SafeWorkPauseReason | undefined =>
  run && pausedRuns.get(run);

/** Bounded continuations preserve completed tool messages; they never replay an old ToolNode. */
async function continueSafePlan(
  params: ContinueOpenPlanParams & { safeWork: SafeWorkScope },
): Promise<boolean> {
  const { run, config, streamOptions, contentParts, indexOffset, signal, safeWork } = params;
  let messages = params.messages;
  let continued = false;
  const deadline = Date.now() + SAFE_WORK_MAX_MS;
  const pause = async (reason: SafeWorkPauseReason, segments: number) => {
    pausedRuns.set(run, reason);
    await saveSafeWorkTask(safeWork, {
      status:
        reason === 'uncertain_write' || reason === 'review_required' ? 'blocked' : 'paused_budget',
      segments,
      plan: findLatestPlan(contentParts),
    }).catch(() => undefined);
    return continued;
  };
  for (let segment = 1; segment <= SAFE_WORK_MAX_SEGMENTS; segment++) {
    if (signal?.aborted || run.getInterrupt() != null) {
      await saveSafeWorkTask(safeWork, {
        status: 'blocked',
        segments: segment,
        plan: findLatestPlan(contentParts),
      }).catch(() => undefined);
      return continued;
    }
    const halt = run.getHaltReason();
    if (halt != null)
      return pause(halt === 'safe_work_time_limit' ? 'time_limit' : 'review_required', segment);
    let uncertain;
    try {
      uncertain = await hasUncertainSafeWork(safeWork);
    } catch {
      return pause('progress_unavailable', segment);
    }
    if (uncertain) return pause('uncertain_write', segment);
    const plan = findLatestPlan(contentParts);
    if (!plan || !hasOpenPlanSteps(plan)) {
      if (await hasIncompleteWorkSources(safeWork)) return pause('review_required', segment);
      if (!plan && isAgentWorkBudgetClosing(run)) return pause('section_limit', segment);
      try {
        await saveSafeWorkTask(safeWork, { status: 'completed', segments: segment, plan });
      } catch {
        return pause('progress_unavailable', segment);
      }
      return continued;
    }
    if (segment === SAFE_WORK_MAX_SEGMENTS) return pause('section_limit', segment);
    if (Date.now() >= deadline) return pause('time_limit', segment);
    // Unknown side effects, code and non-idempotent operations are never automatically repeated.
    const unsafe = contentParts?.some((part) => {
      if (part?.type !== 'tool_call') return false;
      const call = part.tool_call as { name?: string; output?: string } | undefined;
      if (!call?.name) return false;
      if (!isSafeContinuationTool(call.name)) return true;
      if (!/^update_record_mcp_odoo(?:-|$)/i.test(call.name)) return false;
      try {
        return JSON.parse(call.output ?? '{}').verified !== true;
      } catch {
        return true;
      }
    });
    if (unsafe) return pause('review_required', segment);
    const runMessages = run.getRunMessages() ?? [];
    if (!runMessages.length) return pause('history_mismatch', segment);
    const history = await resolveHistory(run, config, messages, runMessages, true);
    if (history == null) return pause('history_mismatch', segment);
    try {
      await saveSafeWorkTask(safeWork, { status: 'running', segments: segment + 1, plan });
    } catch {
      return pause('progress_unavailable', segment);
    }
    if (isAgentWorkBudgetClosing(run) && !resetAgentWorkBudget(run))
      return pause('section_limit', segment);
    if (indexOffset) indexOffset.offset = Math.max(indexOffset.offset, contentParts?.length ?? 0);
    const reminder = new HumanMessage(
      buildPlanReminder(plan) +
        '\nSetze nur offene, bereits freigegebene Schritte fort. Bestätigte Änderungen nicht wiederholen; ungeklärte Änderungen zuerst abgleichen.',
    );
    messages = [...history, reminder];
    await run.processStream({ messages }, config, { ...streamOptions, keepContent: true });
    continued = true;
  }
  return continued;
}
