import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { extractJson } from './json';

const pauseReasons = new Set([
  'cost_limit',
  'section_limit',
  'time_limit',
  'uncertain_write',
  'review_required',
  'history_mismatch',
  'progress_unavailable',
]);

export function isWorkPauseText(text?: string): boolean {
  if (!text) return false;
  try {
    const value = JSON.parse(extractJson(text)) as {
      type?: string;
      code?: string;
      status?: string;
      reason?: string;
    } | null;
    return (
      value != null &&
      (value.code ?? value.type) === ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED &&
      value.status === 'incomplete' &&
      (value.reason === undefined || pauseReasons.has(value.reason))
    );
  } catch {
    return false;
  }
}

export function isWorkPauseMessage(message?: TMessage): boolean {
  if (!message || message.isCreatedByUser) return false;
  for (let index = (message.content?.length ?? 0) - 1; index >= 0; index--) {
    const part = message.content?.[index];
    if (!part) continue;
    return part.type === ContentTypes.ERROR && isWorkPauseText(part.error);
  }
  return message.error === true && isWorkPauseText(message.text);
}
