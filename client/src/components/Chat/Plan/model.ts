import { findLatestPlan, countDoneSteps } from 'librechat-data-provider';
import type { TMessage, TPlan, TPlanStep } from 'librechat-data-provider';

export interface PlanSnapshot {
  /** Response message that owns the plan; a new response starts a new plan. */
  messageId: string;
  plan: TPlan;
}

/**
 * The plan of the branch tail. A plan belongs to one request: once the person
 * sends a new message the tail is their message (or a response without a plan
 * call yet) and the bar closes. Stable function for React Query's `select`.
 */
export function selectTailPlan(message: TMessage | null): PlanSnapshot | null {
  if (!message || message.isCreatedByUser) {
    return null;
  }
  const plan = findLatestPlan(message.content);
  return plan ? { messageId: message.messageId, plan } : null;
}

export type StepDisplay = 'open' | 'running' | 'paused' | 'done';

/** A running step only spins while the turn is live; after a stop it reads as paused. */
export function stepDisplay(step: TPlanStep, live: boolean): StepDisplay {
  if (step.status === 'erledigt') {
    return 'done';
  }
  if (step.status === 'laeuft') {
    return live ? 'running' : 'paused';
  }
  return 'open';
}

/** Step to name in the collapsed header: the running one, else the next open one. */
export function currentStep(plan: TPlan): TPlanStep | undefined {
  return (
    plan.steps.find((step) => step.status === 'laeuft') ??
    plan.steps.find((step) => step.status === 'offen')
  );
}

export interface PlanProgress {
  done: number;
  total: number;
  complete: boolean;
}

export function planProgress(plan: TPlan): PlanProgress {
  const done = countDoneSteps(plan);
  return { done, total: plan.steps.length, complete: done === plan.steps.length };
}
