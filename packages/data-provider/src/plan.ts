/**
 * Shared model of the visible work plan an agent maintains through the
 * `plan_aktualisieren` host tool. The tool call's arguments are the plan: they
 * stream with the message and persist in its content, so server (stop reminder)
 * and client (docked plan bar) read the same parts with the same parser.
 */

export const PLAN_TOOL_NAME = 'plan_aktualisieren';

export const PLAN_MAX_STEPS = 12;
export const PLAN_STEP_MAX_CHARS = 120;
export const PLAN_TITLE_MAX_CHARS = 80;

export type TPlanStepStatus = 'offen' | 'laeuft' | 'erledigt';

export interface TPlanStep {
  text: string;
  status: TPlanStepStatus;
}

export interface TPlan {
  title?: string;
  steps: TPlanStep[];
}

/** Content part shape the plan reader needs; structural so both the client parts and server parts fit. */
export interface PlanSourcePart {
  type?: string;
  tool_call?: unknown;
}

interface PlanToolCall {
  name?: unknown;
  args?: unknown;
}

/** The tool call of a `plan_aktualisieren` part, else undefined. */
function planCallOf(part: PlanSourcePart | null | undefined): PlanToolCall | undefined {
  if (part?.type !== 'tool_call' || part.tool_call == null || typeof part.tool_call !== 'object') {
    return undefined;
  }
  const call = part.tool_call as PlanToolCall;
  return call.name === PLAN_TOOL_NAME ? call : undefined;
}

const STATUS_ALIASES: Record<string, TPlanStepStatus> = {
  offen: 'offen',
  open: 'offen',
  pending: 'offen',
  todo: 'offen',
  laeuft: 'laeuft',
  läuft: 'laeuft',
  in_arbeit: 'laeuft',
  in_progress: 'laeuft',
  running: 'laeuft',
  active: 'laeuft',
  erledigt: 'erledigt',
  done: 'erledigt',
  completed: 'erledigt',
  complete: 'erledigt',
};

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

function toStatus(value: unknown): TPlanStepStatus {
  if (typeof value !== 'string') {
    return 'offen';
  }
  return STATUS_ALIASES[value.trim().toLowerCase()] ?? 'offen';
}

function toStep(raw: unknown): TPlanStep | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as { schritt?: unknown; text?: unknown; status?: unknown };
  const source = typeof entry.schritt === 'string' ? entry.schritt : entry.text;
  if (typeof source !== 'string') {
    return null;
  }
  const text = collapse(source);
  if (text === '') {
    return null;
  }
  return { text: clip(text, PLAN_STEP_MAX_CHARS), status: toStatus(entry.status) };
}

function readArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args === 'string') {
    if (args.trim() === '') {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(args);
      return parsed != null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return args != null && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

/**
 * Parses `plan_aktualisieren` arguments (JSON string while streaming/persisted,
 * object when invoked). Returns null until the arguments are complete JSON with
 * at least one usable step; unknown statuses read as `offen`.
 */
export function parsePlanArgs(args: unknown): TPlan | null {
  const value = readArgs(args);
  if (!value || !Array.isArray(value.schritte)) {
    return null;
  }
  const steps = value.schritte
    .slice(0, PLAN_MAX_STEPS)
    .map(toStep)
    .filter((step): step is TPlanStep => step != null);
  if (steps.length === 0) {
    return null;
  }
  const title = typeof value.titel === 'string' ? collapse(value.titel) : '';
  return title ? { title: clip(title, PLAN_TITLE_MAX_CHARS), steps } : { steps };
}

/** The newest complete plan in a message's content, or null when the turn has none. */
export function findLatestPlan(
  content: ReadonlyArray<PlanSourcePart | null | undefined> | null | undefined,
): TPlan | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (let i = content.length - 1; i >= 0; i--) {
    const call = planCallOf(content[i]);
    const plan = call ? parsePlanArgs(call.args) : null;
    if (plan) {
      return plan;
    }
  }
  return null;
}

export const isPlanToolPart = (part: PlanSourcePart | null | undefined): boolean =>
  planCallOf(part) != null;

export const countDoneSteps = (plan: TPlan): number =>
  plan.steps.reduce((done, step) => (step.status === 'erledigt' ? done + 1 : done), 0);

export const hasOpenPlanSteps = (plan: TPlan | null | undefined): boolean =>
  plan != null && plan.steps.some((step) => step.status !== 'erledigt');
