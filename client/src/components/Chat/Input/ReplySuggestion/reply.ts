import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

export interface ReplyDraft {
  scope: string;
  text: string;
}

export function projectReplyDraft(message: TMessage | null): ReplyDraft | null {
  if (!message || message.isCreatedByUser || message.error || message.unfinished) {
    return null;
  }
  const reply = message.nextSteps?.find((step) => step.kind === 'reply');
  if (!reply?.text.trim()) {
    return null;
  }
  let lastText = message.text;
  for (const part of message.content ?? []) {
    if (part.type === ContentTypes.TEXT) {
      const text = part[ContentTypes.TEXT];
      lastText = typeof text === 'string' ? text : (text?.value ?? '');
    }
  }
  if (!/\?[\s*"'«»„“”‘’)]*$/.test(lastText)) {
    return null;
  }
  return {
    scope: message.messageId,
    text: reply.needsInput ? `${reply.text} …` : reply.text,
  };
}

export function questionReplyDraft(question: {
  active: boolean;
  locked: boolean;
  multiSelect: boolean;
  liveAsk: { actionId: string } | null;
  selected: number | null;
  options: ReadonlyArray<{ label: string; value: string }>;
}): ReplyDraft | null {
  if (!question.active || question.locked || question.multiSelect || !question.liveAsk) {
    return null;
  }
  const choice =
    question.selected == null
      ? question.options.find((option) => /\((?:empfohlen|recommended)\)/i.test(option.label))
      : question.options[question.selected];
  return choice?.value.trim() ? { scope: question.liveAsk.actionId, text: choice.value } : null;
}
