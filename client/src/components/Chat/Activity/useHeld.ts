import { useEffect, useRef, useState } from 'react';

/**
 * Keeps each shown value on screen for at least `minHoldMs`, so a status line does not
 * flicker through stages that only last a few frames. `urgent` values replace the shown
 * value at once (for example a finished run or a question that needs an answer).
 */
export default function useHeld<T>(value: T, minHoldMs: number, urgent = false): T {
  const [shown, setShown] = useState(value);
  const shownAtRef = useRef(Date.now());

  useEffect(() => {
    if (Object.is(value, shown)) {
      return;
    }
    const remaining = minHoldMs - (Date.now() - shownAtRef.current);
    if (urgent || remaining <= 0) {
      shownAtRef.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      shownAtRef.current = Date.now();
      setShown(value);
    }, remaining);
    return () => clearTimeout(timer);
  }, [value, shown, minHoldMs, urgent]);

  return shown;
}
