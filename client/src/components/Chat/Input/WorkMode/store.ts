import { useSyncExternalStore } from 'react';
import { Constants, workModeSchema } from 'librechat-data-provider';
import type { WorkMode } from 'librechat-data-provider';

/**
 * Work mode per conversation, remembered in this browser. The server never
 * trusts it: it validates the value and enforces the mode in its approval
 * policy. A brand-new chat stores its choice under `new` until the first
 * submit gives it an id.
 */
const STORAGE_KEY = 'kisuno:workModes';
const MAX_REMEMBERED = 300;

let modes: Record<string, WorkMode> | null = null;
/** Mode of the new chat that was just submitted; moved to its id once known. */
let pendingNewMode: WorkMode | undefined;
const listeners = new Set<() => void>();

function storeKey(conversationId?: string | null): string {
  if (
    conversationId == null ||
    conversationId === '' ||
    conversationId === Constants.PENDING_CONVO
  ) {
    return Constants.NEW_CONVO;
  }
  return conversationId;
}

function load(): Record<string, WorkMode> {
  if (modes != null) {
    return modes;
  }
  const next: Record<string, WorkMode> = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [id, value] of Object.entries(parsed)) {
        const mode = workModeSchema.safeParse(value);
        if (mode.success) {
          next[id] = mode.data;
        }
      }
    }
  } catch {
    /* unreadable storage: start empty */
  }
  modes = next;
  return modes;
}

function commit(next: Record<string, WorkMode>): void {
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) {
    delete next[id];
  }
  modes = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* the choice then lasts for this page only */
  }
  listeners.forEach((listener) => listener());
}

export function getWorkMode(conversationId?: string | null): WorkMode | undefined {
  return load()[storeKey(conversationId)];
}

export function setWorkMode(conversationId: string | null | undefined, mode: WorkMode): void {
  const key = storeKey(conversationId);
  const next = { ...load() };
  delete next[key];
  next[key] = mode;
  commit(next);
}

/** Mode to send with a submission; marks a new chat's choice for adoption. */
export function getSubmitWorkMode(conversationId?: string | null): WorkMode | undefined {
  const key = storeKey(conversationId);
  const mode = load()[key];
  if (key === Constants.NEW_CONVO) {
    pendingNewMode = mode;
  }
  return mode;
}

/** After a new chat's first submit received its id, carry the chosen mode over. */
export function adoptNewConversationMode(conversationId?: string | null): void {
  const key = storeKey(conversationId);
  if (pendingNewMode == null || key === Constants.NEW_CONVO) {
    return;
  }
  const mode = pendingNewMode;
  pendingNewMode = undefined;
  const next = { ...load() };
  delete next[Constants.NEW_CONVO];
  if (next[key] == null) {
    next[key] = mode;
  }
  commit(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkMode(conversationId?: string | null): WorkMode | undefined {
  const key = storeKey(conversationId);
  return useSyncExternalStore(
    subscribe,
    () => load()[key],
    () => undefined,
  );
}

/** Test helper. */
export function resetWorkModes(): void {
  modes = null;
  pendingNewMode = undefined;
}
