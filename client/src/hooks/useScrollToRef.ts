import { RefObject, useCallback } from 'react';
import throttle from 'lodash/throttle';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
  /** When set, scroll this container directly instead of calling `scrollIntoView`,
   *  which could also move the page or other scrollable ancestors. */
  scrollerRef?: RefObject<HTMLDivElement | null>;
};

type ThrottledFunction = (() => void) & {
  cancel: () => void;
  flush: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement>;
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function useScrollToRef({
  targetRef,
  callback,
  smoothCallback,
  scrollerRef,
}: TUseScrollToRef): ScrollToRefReturn {
  const scrollTo = (behavior: 'instant' | 'smooth', callbackFn: () => void) => {
    const scroller = scrollerRef?.current;
    if (!scroller) {
      targetRef.current?.scrollIntoView({ behavior });
      callbackFn();
      return;
    }
    const top = scroller.scrollHeight;
    if (
      behavior === 'smooth' &&
      !prefersReducedMotion() &&
      typeof scroller.scrollTo === 'function'
    ) {
      scroller.scrollTo({ top, behavior: 'smooth' });
    } else {
      scroller.scrollTop = top;
    }
    callbackFn();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRef = useCallback(
    throttle(() => scrollTo('instant', callback), 145, { leading: true }),
    [targetRef, scrollerRef],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRefSmooth = useCallback(
    throttle(() => scrollTo('smooth', smoothCallback), 750, { leading: true }),
    [targetRef, scrollerRef],
  );

  const handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    scrollToRefSmooth();
  };

  return {
    scrollToRef,
    handleSmoothToRef,
  };
}
