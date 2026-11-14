import { useCallback, useRef, useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { KeyboardEvent, RefObject } from 'react';
import type { ReplyDraft } from './reply';
import { useLatestMessageSelect } from '~/hooks/Messages/useLatestMessage';
import { insertIntoComposer } from '~/components/Chat/NextSteps/insert';
import { projectReplyDraft } from './reply';

export default function useReplySuggestion({
  index,
  conversationId,
  text,
  blocked,
  questionActive,
  questionDraft,
  textAreaRef,
}: {
  index: number;
  conversationId: string;
  text: string;
  blocked: boolean;
  questionActive: boolean;
  questionDraft: ReplyDraft | null;
  textAreaRef: RefObject<HTMLTextAreaElement>;
}) {
  const project = useCallback(
    (message: TMessage | null) =>
      message?.conversationId === conversationId ? projectReplyDraft(message) : null,
    [conversationId],
  );
  const latest = useLatestMessageSelect(index, project);
  const composing = useRef(false);
  const [dismissed, setDismissed] = useState('');
  const candidate = questionActive ? questionDraft : latest;
  const scope = candidate ? `${conversationId}:${candidate.scope}` : '';
  const suggestion =
    !blocked && text.trim() === '' && dismissed !== scope ? (candidate?.text ?? '') : '';

  const accept = (): boolean => {
    const textarea = textAreaRef.current;
    if (!suggestion || !textarea || textarea.readOnly || textarea.value.trim() !== '') {
      return false;
    }
    if (!insertIntoComposer({ text: suggestion }, textarea)) {
      return false;
    }
    setDismissed(scope);
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      !suggestion ||
      composing.current ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(scope);
      return true;
    }
    if (event.key !== 'Tab' || !accept()) {
      return false;
    }
    event.preventDefault();
    return true;
  };

  return {
    suggestion,
    accept,
    handleKeyDown,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
  };
}
