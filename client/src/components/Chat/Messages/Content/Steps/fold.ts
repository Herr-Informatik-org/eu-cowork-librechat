/** Steps that stay visible in a finished group. */
export const VISIBLE_FINISHED_STEPS = 2;

/**
 * Where the visible tail of a finished group starts: at the second-to-last tool
 * step, so reasoning between the last two steps stays with them. `hidden` counts
 * only tool steps, which is what the "N frühere Schritte" button announces.
 */
export function getFoldedStepStart(isToolStep: readonly boolean[]): {
  start: number;
  hidden: number;
} {
  let remaining = VISIBLE_FINISHED_STEPS;
  let toolCount = 0;
  let start = 0;
  for (let i = isToolStep.length - 1; i >= 0; i--) {
    if (!isToolStep[i]) {
      continue;
    }
    toolCount += 1;
    if (remaining > 0) {
      remaining -= 1;
      start = i;
    }
  }
  const hidden = toolCount - VISIBLE_FINISHED_STEPS;
  return hidden > 0 ? { start, hidden } : { start: 0, hidden: 0 };
}
