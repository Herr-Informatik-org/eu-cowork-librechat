import { logger } from '@librechat/data-schemas';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { findLatestPlan, hasOpenPlanSteps } from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { EventStreamOptions, RunStreamConfig } from '@librechat/agents';
import type { PlanSourcePart, TPlan } from 'librechat-data-provider';
import { isAgentWorkBudgetClosing } from '../budget';

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
): Promise<BaseMessage[] | null> {
  let saved: BaseMessage[] = [];
  try {
    const state = await run.graphRunnable?.getState(config);
    saved = Array.isArray(state?.values?.messages) ? state.values.messages : [];
  } catch {
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
}: ContinueOpenPlanParams): Promise<boolean> {
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
