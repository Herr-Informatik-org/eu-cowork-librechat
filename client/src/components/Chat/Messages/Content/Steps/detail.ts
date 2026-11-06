import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Only one step detail is open at a time across the chat: opening a step's
 * input/output closes the previously open one. Steps without a stable id keep
 * their own local state.
 */
let openDetailId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return openDetailId;
}

function setOpenDetailId(id: string | null): void {
  if (openDetailId === id) {
    return;
  }
  openDetailId = id;
  listeners.forEach((listener) => listener());
}

type SetOpen = (next: boolean | ((previous: boolean) => boolean)) => void;

/** `useState`-shaped toggle whose open state is exclusive among all steps with an id. */
export function useExclusiveDetail(
  id: string | undefined,
  initial: () => boolean,
): [boolean, SetOpen] {
  const [localOpen, setLocalOpen] = useState(initial);
  const initialOpenRef = useRef(localOpen);
  const currentId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const exclusive = id != null && id !== '';

  useEffect(() => {
    if (!exclusive) {
      return;
    }
    if (initialOpenRef.current) {
      setOpenDetailId(id);
    }
    return () => {
      if (openDetailId === id) {
        setOpenDetailId(null);
      }
    };
  }, [exclusive, id]);

  const setOpen = useCallback<SetOpen>(
    (next) => {
      if (!exclusive) {
        setLocalOpen(next);
        return;
      }
      const previous = openDetailId === id;
      const value = typeof next === 'function' ? next(previous) : next;
      if (value) {
        setOpenDetailId(id);
      } else if (previous) {
        setOpenDetailId(null);
      }
    },
    [exclusive, id],
  );

  return [exclusive ? currentId === id : localOpen, setOpen];
}
