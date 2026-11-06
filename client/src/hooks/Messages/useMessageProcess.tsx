import throttle from 'lodash/throttle';
import { useEffect, useRef, useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesViewContext } from '~/Providers';
import { isUpwardWheel } from './intent';
import { logger } from '~/utils';

export default function useMessageProcess({ message: _message }: { message?: TMessage | null }) {
  const { conversation, setAbortScroll, isSubmitting } = useMessagesViewContext();

  /** Use ref for isSubmitting to stabilize handleScroll across isSubmitting changes */
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const handleScroll = useMemo(
    () =>
      throttle((event: unknown) => {
        if (!isSubmittingRef.current || !isUpwardWheel(event)) {
          return;
        }
        logger.log('message_scrolling', 'useMessageProcess: upward wheel aborts following');
        setAbortScroll(true);
      }, 500),
    [setAbortScroll],
  );

  useEffect(() => () => handleScroll.cancel(), [handleScroll]);

  return {
    handleScroll,
    isSubmitting,
    conversation,
  };
}
