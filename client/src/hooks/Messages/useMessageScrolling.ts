import { useRef, useCallback, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesConversation, useMessagesSubmission } from '~/Providers';
import { reconcileMessageContentLayout } from './messageLayout';
import useScrollToRef from '~/hooks/useScrollToRef';
import store from '~/store';

/** Distance from the end within which the view counts as "at the latest message". */
const stickThreshold = 48;
/** After an explicit upward gesture, re-sticking near the end waits this long. */
const releaseGraceMs = 250;
const upwardKeys = new Set(['ArrowUp', 'PageUp', 'Home']);

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Follows a streaming reply only while the reader stays at the end. Following stops on an
 * upward scroll, wheel, or key and resumes as soon as the reader returns to the end, so
 * growing content never pulls a reader back down while they read earlier text.
 */
export default function useMessageScrolling(messagesTree?: TMessage[] | null) {
  const autoScroll = useRecoilValue(store.autoScroll);

  const scrollableRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  const lastTopRef = useRef(0);
  const releasedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const suppressNextResizeFollowRef = useRef(false);
  const { conversation, conversationId } = useMessagesConversation();
  const { setAbortScroll, isSubmitting, abortScroll } = useMessagesSubmission();
  const abortScrollRef = useRef(abortScroll);
  abortScrollRef.current = abortScroll;
  const wasSubmittingRef = useRef(isSubmitting);

  const getDistanceToEnd = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return 0;
    }
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
  }, []);

  const stick = useCallback(() => {
    stuckRef.current = true;
    if (abortScrollRef.current === true) {
      setAbortScroll(false);
    }
  }, [setAbortScroll]);

  const release = useCallback(() => {
    stuckRef.current = false;
    releasedAtRef.current = now();
  }, []);

  /** The scroll-to-bottom button owns the IntersectionObserver and reports the end
   *  marker's visibility. A visible end re-sticks; an end pushed out of view by growing
   *  content does not release, because only the reader's own movement may do that. */
  const handleNearBottomChange = useCallback(
    (isNearBottom: boolean) => {
      if (isNearBottom && now() - releasedAtRef.current > releaseGraceMs) {
        stick();
      }
    },
    [stick],
  );

  const debouncedHandleScroll = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return;
    }
    const top = scrollEl.scrollTop;
    const distance = getDistanceToEnd();
    const graceOver = now() - releasedAtRef.current > releaseGraceMs;
    if (distance <= 2 || (distance <= stickThreshold && graceOver)) {
      stick();
    } else if (top < lastTopRef.current - 1) {
      release();
    }
    lastTopRef.current = top;
  }, [getDistanceToEnd, release, stick]);

  const scrollCallback = () => {
    reconcileMessageContentLayout(scrollableRef.current);
    stuckRef.current = true;
    lastTopRef.current = scrollableRef.current?.scrollTop ?? 0;
  };

  const { scrollToRef: scrollToBottom, handleSmoothToRef } = useScrollToRef({
    targetRef: messagesEndRef,
    scrollerRef: scrollableRef,
    callback: scrollCallback,
    smoothCallback: () => {
      scrollCallback();
      setAbortScroll(false);
    },
  });

  const clampScrollToContent = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return false;
    }

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (scrollEl.scrollTop <= maxScrollTop) {
      return false;
    }

    scrollEl.scrollTop = maxScrollTop;
    lastTopRef.current = maxScrollTop;
    return true;
  }, []);

  const shouldFollow = useCallback(
    () => isSubmitting && abortScroll !== true && stuckRef.current,
    [abortScroll, isSubmitting],
  );

  const reconcileContentResize = useCallback(
    (shouldFollowResize = true) => {
      if (clampScrollToContent()) {
        return;
      }

      if (suppressNextResizeFollowRef.current) {
        suppressNextResizeFollowRef.current = false;
        stuckRef.current = getDistanceToEnd() <= stickThreshold;
        return;
      }

      if (shouldFollowResize && shouldFollow()) {
        scrollToBottom?.();
      }
    },
    [clampScrollToContent, getDistanceToEnd, scrollToBottom, shouldFollow],
  );

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => reconcileContentResize());
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [reconcileContentResize]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) {
      return;
    }

    const suppressNextResizeFollow = () => {
      suppressNextResizeFollowRef.current = true;
    };

    contentEl.addEventListener('pointerdown', suppressNextResizeFollow, true);
    contentEl.addEventListener('keydown', suppressNextResizeFollow, true);
    return () => {
      contentEl.removeEventListener('pointerdown', suppressNextResizeFollow, true);
      contentEl.removeEventListener('keydown', suppressNextResizeFollow, true);
    };
  }, []);

  useEffect(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scrollEl.scrollTop > 0) {
        release();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (upwardKeys.has(event.key) || (event.key === ' ' && event.shiftKey)) {
        release();
      }
    };

    scrollEl.addEventListener('wheel', onWheel, { passive: true });
    scrollEl.addEventListener('keydown', onKeyDown);
    return () => {
      scrollEl.removeEventListener('wheel', onWheel);
      scrollEl.removeEventListener('keydown', onKeyDown);
    };
  }, [release]);

  useEffect(() => {
    const started = isSubmitting && !wasSubmittingRef.current;
    wasSubmittingRef.current = isSubmitting;
    if (started) {
      releasedAtRef.current = Number.NEGATIVE_INFINITY;
      stick();
    }
  }, [isSubmitting, stick]);

  useEffect(() => {
    if (!messagesTree || messagesTree.length === 0) {
      return;
    }

    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    if (scrollToBottom && shouldFollow()) {
      scrollToBottom();
    }

    return () => {
      if (abortScroll === true) {
        scrollToBottom && scrollToBottom.cancel();
      }
    };
  }, [messagesTree, scrollToBottom, abortScroll, shouldFollow]);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    if (scrollToBottom && autoScroll && conversationId !== Constants.NEW_CONVO) {
      scrollToBottom();
    }
  }, [autoScroll, conversationId, scrollToBottom]);

  return {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    scrollToBottom,
    handleSmoothToRef,
    debouncedHandleScroll,
    handleNearBottomChange,
  };
}
