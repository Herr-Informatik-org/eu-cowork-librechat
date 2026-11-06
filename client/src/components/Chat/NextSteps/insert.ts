import type { TNextStep } from 'librechat-data-provider';
import { insertTextAtCursor, forceResize } from '~/utils/textarea';
import { mainTextareaId } from '~/common';

export interface DraftInsertion {
  /** Text to insert at the end of the draft (empty when the suggestion is already there). */
  text: string;
  /** Replace the whole draft instead of appending (it holds only whitespace). */
  replace: boolean;
}

/** Visible label of a suggestion: an open step keeps its ellipsis. */
export const nextStepLabel = (step: TNextStep): string =>
  step.needsInput === true ? `${step.text} …` : step.text;

/**
 * How a suggestion joins the current draft without losing it: an empty draft
 * is replaced, a non-empty draft gets the suggestion on its own line, and a
 * suggestion that already ends the draft is not added twice. An open step
 * ends with a space so the person can continue typing right away.
 */
export function planInsertion(draft: string, step: TNextStep): DraftInsertion {
  const body = step.needsInput === true ? `${step.text} ` : step.text;
  if (draft.trim() === '') {
    return { text: body, replace: true };
  }
  if (draft.trimEnd().endsWith(step.text)) {
    return { text: '', replace: false };
  }
  return { text: `${draft.endsWith('\n') ? '' : '\n'}${body}`, replace: false };
}

/**
 * Loads a suggestion into the composer and leaves the cursor at its end, ready
 * to send (or to complete an open step). Uses the browser's undoable insert, so
 * Cmd/Ctrl+Z restores the previous draft. Returns false without a composer.
 */
export function insertIntoComposer(
  step: TNextStep,
  textarea: HTMLTextAreaElement | null = document.getElementById(
    mainTextareaId,
  ) as HTMLTextAreaElement | null,
): boolean {
  if (!textarea || textarea.disabled) {
    return false;
  }
  const draft = textarea.value;
  const { text, replace } = planInsertion(draft, step);
  textarea.focus();
  textarea.setSelectionRange(replace ? 0 : draft.length, draft.length);
  if (text !== '') {
    insertTextAtCursor(textarea, text);
  }
  const end = textarea.value.length;
  textarea.setSelectionRange(end, end);
  forceResize(textarea);
  textarea.scrollTop = textarea.scrollHeight;
  return true;
}
