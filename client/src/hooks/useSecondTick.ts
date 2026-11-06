import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let tick = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      tick += 1;
      listeners.forEach((listener) => listener());
    }, 1_000);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
};

const noopSubscribe = () => () => undefined;
const getSnapshot = (): number => tick;
const getIdleSnapshot = (): number => -1;

/**
 * Shared one-second ticker for live elapsed-time labels. All running timers re-render
 * from one interval instead of one interval per component, and the interval stops when
 * no timer is active. Pass `enabled = false` once a run ends so finished rows stop
 * re-rendering.
 */
export default function useSecondTick(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    enabled ? getSnapshot : getIdleSnapshot,
    getIdleSnapshot,
  );
}
