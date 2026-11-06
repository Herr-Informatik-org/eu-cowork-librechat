import {
  BLOCKED_OUTPUT_PREFIX,
  WORK_MODE_PLAN_MARKER,
  PROPOSAL_REJECTED_REASON,
} from 'librechat-data-provider';

/** Final state shown on a proposal card after the person (or the policy) decided. */
export type ProposalOutcome = 'approved' | 'rejected' | 'planned';

const STORAGE_KEY = 'kisuno:proposalDecisions';
const MAX_REMEMBERED = 200;

type Remembered = Record<string, 'approved' | 'rejected'>;

/** Parsed once per page; every write goes through {@link rememberDecision}. */
let cache: Remembered | null = null;

/**
 * Decisions made in this browser, by tool call id. The server keeps no record of
 * an approval on the tool call itself, so «Übernommen» survives a reload only
 * here; «Verworfen» and «Nur geplant» are also recognized from the tool output.
 */
function readAll(): Remembered {
  if (cache != null) {
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = typeof parsed === 'object' && parsed !== null ? (parsed as Remembered) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function rememberDecision(toolCallId: string, outcome: 'approved' | 'rejected'): void {
  if (toolCallId === '') {
    return;
  }
  const all = { ...readAll() };
  delete all[toolCallId];
  all[toolCallId] = outcome;
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) {
    delete all[key];
  }
  cache = all;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: the badge then only lasts for this view */
  }
}

export function recallDecision(
  toolCallId: string | undefined,
): 'approved' | 'rejected' | undefined {
  if (toolCallId == null || toolCallId === '') {
    return undefined;
  }
  return readAll()[toolCallId];
}

/** Outcome readable from the tool result alone (works after reload and on other devices). */
export function outcomeFromOutput(output: string | null | undefined): ProposalOutcome | undefined {
  if (typeof output !== 'string' || !output.startsWith(BLOCKED_OUTPUT_PREFIX)) {
    return undefined;
  }
  const reason = output.slice(BLOCKED_OUTPUT_PREFIX.length);
  if (reason.startsWith(WORK_MODE_PLAN_MARKER)) {
    return 'planned';
  }
  if (reason.startsWith(PROPOSAL_REJECTED_REASON)) {
    return 'rejected';
  }
  return undefined;
}

/** Test helper: forget the parsed cache so the next read hits storage again. */
export function resetDecisionCache(): void {
  cache = null;
}

/** Output first (authoritative for rejections), then this browser's memory. */
export function resolveOutcome(
  toolCallId: string | undefined,
  output: string | null | undefined,
): ProposalOutcome | undefined {
  return outcomeFromOutput(output) ?? recallDecision(toolCallId);
}
