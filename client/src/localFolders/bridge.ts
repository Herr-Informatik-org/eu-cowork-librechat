import type { Agents, LocalFolderRequest, TEphemeralAgent } from 'librechat-data-provider';
import type { ResumeAgentFields } from '~/data-provider/SSE/mutations';
import { submitToolApproval } from '~/data-provider/SSE/mutations';
import {
  executeLocalFolder,
  getLocalFolders,
  getLocalFolderSession,
  isLocalFolderUser,
  notifyLocalFolders,
  onLocalFolderReset,
} from './store';

type ActionState = 'reading' | 'sent' | 'retry' | 'mixed' | 'unavailable' | 'cancelled';
type Entry = {
  signature: string;
  state: ActionState;
  running: boolean;
  decisions?: Agents.ToolApprovalResolution[];
  retry?: () => void;
  createdAt: number;
  folderIds: string[];
  retryAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  conversationIds: string[];
  generationCreatedAt: number;
  controller: AbortController;
};
const actions = new Map<string, Entry>();
const views = new Map<string, Entry>();
const cancelledGenerations = new Map<string, number>();
onLocalFolderReset((folderId) => {
  if (!folderId) {
    actions.forEach((entry) => {
      clearTimeout(entry.retryTimer);
      entry.controller.abort();
    });
    actions.clear();
    views.clear();
    cancelledGenerations.clear();
  } else {
    for (const entry of actions.values()) {
      if (!entry.folderIds.includes(folderId)) continue;
      entry.decisions = entry.decisions?.map((decision) => ({
        tool_call_id: decision.tool_call_id,
        decision: 'reject',
        reason: 'Der lokale Ordnerzugriff wurde entfernt.',
      }));
      if (entry.state === 'retry') entry.retry?.();
    }
  }
  notifyLocalFolders();
});

export const getLocalFolderAction = (actionId: string) => views.get(actionId)?.state;
export const retryLocalFolderAction = (actionId: string) => views.get(actionId)?.retry?.();

/** Stop browser access synchronously, before waiting for the server abort. */
export function cancelLocalFolderGeneration(conversationId: string, generationCreatedAt: number) {
  if (!Number.isFinite(generationCreatedAt)) return;
  cancelledGenerations.set(
    conversationId,
    Math.max(cancelledGenerations.get(conversationId) ?? -Infinity, generationCreatedAt),
  );
  if (cancelledGenerations.size > 128) {
    const oldest = cancelledGenerations.keys().next().value;
    if (oldest !== undefined) cancelledGenerations.delete(oldest);
  }
  for (const entry of actions.values()) {
    if (
      entry.generationCreatedAt !== generationCreatedAt ||
      !entry.conversationIds.includes(conversationId)
    )
      continue;
    clearTimeout(entry.retryTimer);
    entry.controller.abort();
    entry.decisions = undefined;
    entry.retry = undefined;
    entry.state = 'cancelled';
  }
  notifyLocalFolders();
}

function parseRequest(value: unknown): LocalFolderRequest | null {
  try {
    const data: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const args = data as Record<string, unknown>;
    if (
      typeof args.folderId !== 'string' ||
      !['list', 'search', 'read', 'inspect'].includes(String(args.operation)) ||
      !Number.isInteger(args.maxChars) ||
      Number(args.maxChars) < 512 ||
      Number(args.maxChars) > 16000
    )
      return null;
    for (const field of ['path', 'query', 'cursor']) {
      if (
        args[field] !== undefined &&
        (typeof args[field] !== 'string' || String(args[field]).length > 4096)
      )
        return null;
    }
    for (const [field, minimum] of [
      ['startByte', 0],
      ['page', 1],
    ] as const) {
      if (
        args[field] !== undefined &&
        (!Number.isSafeInteger(args[field]) || Number(args[field]) < minimum)
      )
        return null;
    }
    return {
      folderId: args.folderId,
      operation: args.operation as LocalFolderRequest['operation'],
      maxChars: Number(args.maxChars),
      ...(typeof args.path === 'string' && { path: args.path }),
      ...(typeof args.query === 'string' && { query: args.query }),
      ...(typeof args.cursor === 'string' && { cursor: args.cursor }),
      ...(typeof args.startByte === 'number' && { startByte: args.startByte }),
      ...(typeof args.page === 'number' && { page: args.page }),
    };
  } catch {
    return null;
  }
}

export interface LocalFolderActionOptions {
  pendingAction: Agents.PendingAction;
  userId: string;
  fields: ResumeAgentFields;
  isCurrent: () => boolean;
  verifyCurrent: () => Promise<boolean>;
  signal?: AbortSignal;
  originConversationId?: string;
}

/** Only a live, generation-fenced local-only pause can produce browser data. */
export function handleLocalFolderAction(options: LocalFolderActionOptions): void {
  const { pendingAction: pending, fields, userId, isCurrent, signal } = options;
  const conversationIds = [fields.conversationId, options.originConversationId].filter(
    (id): id is string => !!id,
  );
  if (
    pending.payload.type !== 'tool_approval' ||
    !isCurrent() ||
    signal?.aborted ||
    !isLocalFolderUser(userId) ||
    conversationIds.some(
      (id) => (cancelledGenerations.get(id) ?? -Infinity) >= Number(fields.generationCreatedAt),
    )
  )
    return;
  const calls = pending.payload.action_requests;
  if (!calls.some((call) => call.name === 'local_folder')) return;
  if (
    pending.streamId !== fields.conversationId ||
    (pending.conversationId && pending.conversationId !== fields.conversationId) ||
    !Number.isFinite(fields.generationCreatedAt) ||
    (pending.expiresAt != null && pending.expiresAt <= Date.now())
  )
    return;
  const key = `${userId}:${fields.conversationId}:${fields.generationCreatedAt}:${pending.actionId}`;
  const signature = JSON.stringify(pending.payload);
  let entry = actions.get(key);
  if (entry && entry.signature !== signature) return;
  if (!entry) {
    // Bound retained result data; active entries are never evicted to prevent duplicate reads.
    for (const [oldKey, old] of actions) {
      if (!old.running && (actions.size >= 8 || Date.now() - old.createdAt > 300000)) {
        clearTimeout(old.retryTimer);
        actions.delete(oldKey);
        for (const [id, view] of views) if (view === old) views.delete(id);
      }
    }
    if (actions.size >= 8) return;
    entry = {
      signature,
      state: 'reading',
      running: false,
      createdAt: Date.now(),
      folderIds: calls.map((call) => parseRequest(call.arguments)?.folderId ?? ''),
      retryAttempts: 0,
      conversationIds,
      generationCreatedAt: Number(fields.generationCreatedAt),
      controller: new AbortController(),
    };
    actions.set(key, entry);
    views.set(pending.actionId, entry);
  }
  const currentEntry = entry;
  if (calls.some((call) => call.name !== 'local_folder')) {
    currentEntry.state = 'mixed';
    notifyLocalFolders();
    return;
  }
  const session = getLocalFolderSession();
  const live = () =>
    isCurrent() &&
    !signal?.aborted &&
    !currentEntry.controller.signal.aborted &&
    isLocalFolderUser(userId) &&
    session === getLocalFolderSession() &&
    actions.get(key) === currentEntry;
  const run = async () => {
    if (currentEntry.running || currentEntry.state === 'sent' || !live()) return;
    clearTimeout(currentEntry.retryTimer);
    currentEntry.retryTimer = undefined;
    currentEntry.running = true;
    currentEntry.state = 'reading';
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    currentEntry.controller.signal.addEventListener('abort', abort, { once: true });
    notifyLocalFolders();
    try {
      if (!(await options.verifyCurrent()) || !live()) {
        currentEntry.state = 'unavailable';
        return;
      }
      if (!currentEntry.decisions) {
        const decisions: Agents.ToolApprovalResolution[] = [];
        for (const call of calls) {
          const review =
            pending.payload.type === 'tool_approval'
              ? pending.payload.review_configs.find(
                  (config) =>
                    config.tool_call_id === call.tool_call_id &&
                    config.action_name === 'local_folder',
                )
              : undefined;
          if (
            !review?.allowed_decisions.includes('respond') ||
            !review.allowed_decisions.includes('reject')
          )
            return;
          const request = parseRequest(call.arguments);
          const declared = (fields.ephemeralAgent as TEphemeralAgent | null)?.localFolders?.some(
            (grant) => grant.id === request?.folderId,
          );
          if (!request || !declared) {
            decisions.push({
              tool_call_id: call.tool_call_id,
              decision: 'reject',
              reason:
                'Die lokale Ordnerabfrage gehört nicht zur aktuellen Freigabe. Bitte den Ordner verbinden und die Anfrage wiederholen.',
            });
            continue;
          }
          try {
            const result = await executeLocalFolder(
              userId,
              fields.conversationId,
              request,
              controller.signal,
            );
            if (!live()) return;
            const responseText = JSON.stringify(result);
            if (responseText.length > Math.min(16000, request.maxChars))
              throw new Error('Die lokale Antwort überschreitet das erlaubte Kontextbudget.');
            decisions.push({ tool_call_id: call.tool_call_id, decision: 'respond', responseText });
          } catch (error) {
            if (!live()) return;
            const detail = error instanceof Error ? error.message.slice(0, 400) : '';
            decisions.push({
              tool_call_id: call.tool_call_id,
              decision: 'reject',
              reason:
                'Der lokale Ordner konnte in diesem Browser nicht gelesen werden. Bitte erneut verbinden und die Anfrage wiederholen.' +
                (detail ? ' ' + detail : ''),
            });
          }
        }
        currentEntry.decisions = decisions;
      }
      if (!live()) return;
      if (!(await options.verifyCurrent()) || !live()) return;
      // Recheck revocation after the final await and immediately before sending.
      const available = new Set(
        getLocalFolders(userId, fields.conversationId).map((folder) => folder.id),
      );
      const decisions = currentEntry.decisions.map((decision, index) =>
        decision.decision === 'respond' &&
        !available.has(parseRequest(calls[index].arguments)?.folderId ?? '')
          ? {
              tool_call_id: decision.tool_call_id,
              decision: 'reject' as const,
              reason: 'Der lokale Ordnerzugriff wurde entfernt.',
            }
          : decision,
      );
      currentEntry.decisions = decisions;
      await submitToolApproval({ ...fields, actionId: pending.actionId, decisions });
      if (live())
        currentEntry.state = decisions.every((decision) => decision.decision === 'reject')
          ? 'unavailable'
          : 'sent';
    } catch (error) {
      if (live()) {
        const status = (error as { response?: { status?: number } } | null)?.response?.status;
        const transient = status == null || status >= 500 || status === 429;
        currentEntry.state = transient ? 'retry' : 'unavailable';
        // A fresh pause can precede publication of its durable status snapshot.
        // Retry the same action/result, never repeat an already completed read.
        if (transient && currentEntry.retryAttempts < 3) {
          const delay = [300, 900, 1800][currentEntry.retryAttempts++];
          currentEntry.retryTimer = setTimeout(() => currentEntry.retry?.(), delay);
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      currentEntry.controller.signal.removeEventListener('abort', abort);
      currentEntry.running = false;
      notifyLocalFolders();
      if (!live()) queueMicrotask(() => currentEntry.retry?.());
    }
  };
  currentEntry.retry = () => {
    void run();
  };
  if (currentEntry.state !== 'retry' && currentEntry.state !== 'unavailable') void run();
}
