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
  /** A terminal outcome the user has already looked at; the sidebar no longer announces it. */
  seen?: boolean;
};
type TerminalState = Extract<ActivityState, 'done' | 'error' | 'stopped'>;
/** The submission fields a run is identified by. A cleared submission (`{}`) has none. */
type RunSubmission = Partial<
  Pick<TSubmission, 'clientRequestId' | 'initialResponse' | 'userMessage' | 'conversation'>
>;
export type BackgroundActivityUpdate = Pick<ConversationActivity, 'state' | 'stage'> &
  Partial<Pick<ConversationActivity, 'messageId'>>;

const activities = new Map<string, ConversationActivity>();
const runConversations = new Map<string, string>();
const listeners = new Set<() => void>();
const TERMINAL = new Set<ActivityState>(['done', 'error', 'stopped']);
const LIVE = new Set<ActivityState>(['waiting', 'running']);
const STORAGE_PREFIX = 'eucowork:activity:v1:';
/** Runs reconstructed outside an attached stream; a stream may take them over. */
const PROJECTED_RUN_PREFIXES = ['question:', 'job:'];
let activityUserId: string | null = null;
let hasUserScope = false;
let viewedConversationId: string | null = null;

export const isTerminalActivity = (
  activity?: ConversationActivity | null,
): activity is ConversationActivity & { state: TerminalState } =>
  activity != null && TERMINAL.has(activity.state);

const isProjectedRun = (runId: string) =>
  PROJECTED_RUN_PREFIXES.some((prefix) => runId.startsWith(prefix));

const notify = () => listeners.forEach((listener) => listener());

/** Store observed outcomes only, without message content, tool names, or live work. */
function persistOutcomes() {
  if (!activityUserId) return;
  try {
    const outcomes = [...activities.values()]
      .filter((activity) => TERMINAL.has(activity.state) && activity.seen !== true)
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
  notify();
}

export const getConversationActivity = (conversationId: string) =>
  activities.get(conversationId) ?? null;

export function subscribeActivity(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: ConversationActivity) {
  if (hasUserScope && !activityUserId) return;
  const seen =
    TERMINAL.has(next.state) &&
    (next.seen === true || next.conversationId === viewedConversationId);
  const activity: ConversationActivity = { ...next, seen: seen || undefined };
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
  notify();
}

/** `undefined` when the submission describes no run, for example after a new chat cleared it. */
const submissionRunId = (submission?: RunSubmission | null) =>
  submission?.clientRequestId ||
  submission?.initialResponse?.messageId ||
  submission?.userMessage?.messageId ||
  undefined;

/** A completed historical message is not evidence of an observed successful run. */
export function beginConversationActivity(
  submission: RunSubmission | null | undefined,
  resolvedId?: string | null,
  replace = true,
  responseId?: string,
) {
  const runId = submissionRunId(submission);
  if (!runId) return;
  const conversationId = resolvedId ?? submission?.conversation?.conversationId ?? 'new';
  const current = activities.get(conversationId);
  if (current?.runId === runId) {
    if (responseId && current.messageId !== responseId)
      publish({ ...current, messageId: responseId });
    return;
  }
  if (current && !replace && !isProjectedRun(current.runId)) return;
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
    messageId: responseId ?? submission?.initialResponse?.messageId,
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
  submission: RunSubmission | null | undefined,
  result: {
    conversationId?: string | null;
    final?: boolean;
    aborted?: boolean;
    earlyAbort?: boolean;
    error?: boolean;
    responseMessage?: TMessage;
  },
) {
  const runId = submissionRunId(submission);
  if (!runId) return;
  const conversationId =
    result.conversationId && result.conversationId !== 'new'
      ? result.conversationId
      : (runConversations.get(runId) ?? submission?.conversation?.conversationId ?? 'new');
  const pending = activities.get('new');
  const current =
    activities.get(conversationId) ?? (pending?.runId === runId ? pending : undefined);
  if (hasUserScope && !current) return;
  if (current && current.runId !== runId) return;
  const response = result.responseMessage;
  let state: ActivityState = 'done';
  if (result.aborted || result.earlyAbort || response?.unfinished || !result.final)
    state = 'stopped';
  if (response?.error || result.error) state = 'error';
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

export function failConversationActivity(submission: RunSubmission | null | undefined) {
  const userMessage = submission?.userMessage;
  finishConversationActivity(submission, {
    error: true,
    responseMessage: userMessage
      ? { ...userMessage, isCreatedByUser: false, error: true }
      : undefined,
  });
}

export function clearConversationActivities() {
  activities.clear();
  runConversations.clear();
  persistOutcomes();
  notify();
}

/** Conversations whose last observation is an unfinished run. */
export function getLiveConversationIds() {
  const ids: string[] = [];
  for (const [conversationId, activity] of activities) {
    if (conversationId !== 'new' && LIVE.has(activity.state)) ids.push(conversationId);
  }
  return ids;
}

/**
 * The conversation on screen. Its outcomes count as seen at once, so the sidebar only
 * announces results the user has not looked at yet. An open question stays visible.
 */
export function setViewedConversation(conversationId?: string | null) {
  viewedConversationId = conversationId || null;
  if (!viewedConversationId) return;
  const current = activities.get(viewedConversationId);
  if (!current || !TERMINAL.has(current.state) || current.seen === true) return;
  publish({ ...current, seen: true });
}

/**
 * Applies a status observed without an attached stream (job list, stream status or saved
 * messages). It is dropped when anything changed the conversation since `expected` was read,
 * so a live stream always wins over a background observation. `null` forgets the run.
 */
export function applyBackgroundActivity(
  conversationId: string,
  update: BackgroundActivityUpdate | null,
  expected: ConversationActivity | null,
) {
  if (hasUserScope && !activityUserId) return;
  const current = activities.get(conversationId) ?? null;
  if (current !== expected) return;
  if (!update) {
    if (!current) return;
    activities.delete(conversationId);
    runConversations.delete(current.runId);
    persistOutcomes();
    notify();
    return;
  }
  const live = current && !TERMINAL.has(current.state) ? current : null;
  if (
    live &&
    !TERMINAL.has(update.state) &&
    live.state === update.state &&
    live.stage === update.stage
  )
    return;
  const now = Date.now();
  publish({
    conversationId,
    runId: live?.runId ?? `job:${conversationId}:${now}`,
    state: update.state,
    stage: update.stage,
    messageId: update.messageId ?? live?.messageId,
    startedAt: live?.startedAt ?? now,
    updatedAt: now,
  });
}
