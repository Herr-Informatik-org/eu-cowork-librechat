import type { TMessage, TSubmission } from 'librechat-data-provider';

export type ActivityState = 'waiting' | 'running' | 'needs-input' | 'done' | 'error' | 'stopped';
export type ActivityStage = 'waiting' | 'thinking' | 'writing' | 'tool' | 'question';
export type ConversationActivity = {
  conversationId: string;
  runId: string;
  state: ActivityState;
  stage: ActivityStage;
  tool?: string;
  messageId?: string;
  startedAt: number;
  updatedAt: number;
};

const activities = new Map<string, ConversationActivity>();
const runConversations = new Map<string, string>();
const listeners = new Set<() => void>();
const TERMINAL = new Set<ActivityState>(['done', 'error', 'stopped']);
const STORAGE_PREFIX = 'eucowork:activity:v1:';
let activityUserId: string | null = null;
let hasUserScope = false;

/** Store observed outcomes only, without message content, tool names, or live work. */
function persistOutcomes() {
  if (!activityUserId) return;
  try {
    const outcomes = [...activities.values()]
      .filter((activity) => TERMINAL.has(activity.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map(({ conversationId, runId, state, startedAt, updatedAt }) => ({
        conversationId,
        runId,
        state,
        startedAt,
        updatedAt,
      }));
    sessionStorage.setItem(STORAGE_PREFIX + activityUserId, JSON.stringify(outcomes));
  } catch {
    // Restricted browser storage must not interrupt a conversation.
  }
}

export function setConversationActivityUser(userId?: string | null) {
  const nextUserId = userId || null;
  if (hasUserScope && activityUserId === nextUserId) return;
  hasUserScope = true;
  activityUserId = nextUserId;
  activities.clear();
  runConversations.clear();
  if (nextUserId) {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(STORAGE_PREFIX + nextUserId) || '[]',
      );
      if (Array.isArray(saved)) {
        for (const value of saved.slice(0, 200)) {
          if (
            value == null ||
            typeof value !== 'object' ||
            typeof value.conversationId !== 'string' ||
            value.conversationId.length > 160 ||
            typeof value.runId !== 'string' ||
            value.runId.length > 160 ||
            !TERMINAL.has(value.state) ||
            !Number.isFinite(value.startedAt) ||
            !Number.isFinite(value.updatedAt)
          )
            continue;
          const activity: ConversationActivity = {
            conversationId: value.conversationId,
            runId: value.runId,
            state: value.state,
            stage: 'waiting',
            startedAt: value.startedAt,
            updatedAt: value.updatedAt,
          };
          activities.set(activity.conversationId, activity);
          runConversations.set(activity.runId, activity.conversationId);
        }
      }
    } catch {
      // Ignore invalid or unavailable storage rather than inventing a status.
    }
  }
  listeners.forEach((listener) => listener());
}

export const getConversationActivity = (conversationId: string) =>
  activities.get(conversationId) ?? null;

export function subscribeActivity(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(activity: ConversationActivity) {
  if (hasUserScope && !activityUserId) return;
  const previous = activities.get(activity.conversationId);
  if (previous && previous.runId !== activity.runId) runConversations.delete(previous.runId);
  activities.set(activity.conversationId, activity);
  runConversations.set(activity.runId, activity.conversationId);
  if (activities.size > 500) {
    for (const [id, value] of activities) {
      if (TERMINAL.has(value.state)) {
        activities.delete(id);
        runConversations.delete(value.runId);
        break;
      }
    }
  }
  persistOutcomes();
  listeners.forEach((listener) => listener());
}

const submissionRunId = (submission: TSubmission) =>
  submission.clientRequestId ??
  submission.initialResponse?.messageId ??
  submission.userMessage.messageId;

/** A completed historical message is not evidence of an observed successful run. */
export function beginConversationActivity(
  submission: TSubmission,
  resolvedId?: string | null,
  replace = true,
  responseId?: string,
) {
  const conversationId = resolvedId ?? submission.conversation.conversationId ?? 'new';
  const runId = submissionRunId(submission);
  const current = activities.get(conversationId);
  if (current?.runId === runId) {
    if (responseId && current.messageId !== responseId)
      publish({ ...current, messageId: responseId });
    return;
  }
  if (current && !replace && !current.runId.startsWith('question:')) return;
  const pending = activities.get('new');
  if (conversationId !== 'new' && pending?.runId === runId) {
    activities.delete('new');
    publish({ ...pending, conversationId, messageId: responseId ?? pending.messageId });
    return;
  }
  publish({
    conversationId,
    runId,
    state: 'waiting',
    stage: 'waiting',
    messageId: responseId ?? submission.initialResponse?.messageId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export function updateConversationActivity(
  conversationId: string,
  update: Pick<ConversationActivity, 'state' | 'stage'> &
    Partial<Pick<ConversationActivity, 'tool' | 'messageId'>>,
  expectedIdentity?: Partial<Pick<ConversationActivity, 'runId' | 'messageId'>>,
) {
  const current = activities.get(conversationId);
  // A queued query projection cannot undo a newer SSE response or run identity.
  if (
    expectedIdentity &&
    (current?.runId !== expectedIdentity.runId || current?.messageId !== expectedIdentity.messageId)
  )
    return;
  if (current && TERMINAL.has(current.state) && update.state !== 'needs-input') return;
  if (!current && update.state !== 'needs-input') return;
  if (
    current?.state === update.state &&
    current.stage === update.stage &&
    current.tool === update.tool &&
    current.messageId === update.messageId
  )
    return;
  publish({
    conversationId,
    startedAt: current?.startedAt ?? Date.now(),
    ...current,
    runId:
      current && !TERMINAL.has(current.state)
        ? current.runId
        : `question:${update.messageId ?? conversationId}`,
    ...update,
    tool: update.stage === 'tool' ? update.tool : undefined,
    updatedAt: Date.now(),
  });
}

export function finishConversationActivity(
  submission: TSubmission,
  result: {
    conversationId?: string | null;
    final?: boolean;
    aborted?: boolean;
    earlyAbort?: boolean;
    responseMessage?: TMessage;
  },
) {
  const runId = submissionRunId(submission);
  const conversationId =
    result.conversationId && result.conversationId !== 'new'
      ? result.conversationId
      : (runConversations.get(runId) ?? submission.conversation.conversationId ?? 'new');
  const pending = activities.get('new');
  const current =
    activities.get(conversationId) ?? (pending?.runId === runId ? pending : undefined);
  if (hasUserScope && !current) return;
  if (current && current.runId !== runId) return;
  const response = result.responseMessage;
  let state: ActivityState = 'done';
  if (result.aborted || result.earlyAbort || response?.unfinished || !result.final)
    state = 'stopped';
  if (response?.error) state = 'error';
  if (conversationId !== 'new' && activities.get('new')?.runId === runId) activities.delete('new');
  publish({
    conversationId,
    runId,
    state,
    stage: 'waiting',
    messageId: response?.messageId,
    startedAt: current?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

export function failConversationActivity(submission: TSubmission) {
  finishConversationActivity(submission, {
    responseMessage: { ...submission.userMessage, isCreatedByUser: false, error: true },
  });
}

export function clearConversationActivities() {
  activities.clear();
  runConversations.clear();
  persistOutcomes();
  listeners.forEach((listener) => listener());
}
