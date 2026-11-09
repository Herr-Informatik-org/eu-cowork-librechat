import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { ActiveJobsResponse } from '~/data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import {
  fetchStreamStatus,
  useGetMessagesByConvoId,
  refreshConversationTitle,
} from '~/data-provider';
import {
  subscribeActivity,
  isTerminalActivity,
  setViewedConversation,
  getLiveConversationIds,
  getConversationActivity,
  applyBackgroundActivity,
  beginConversationActivity,
  updateConversationActivity,
} from '~/store/activity';
import { activityFromMessages, outcomeFromMessages } from './model';
import { isNotFoundError } from '~/utils/errors';
import { useChatContext } from '~/Providers';
import store from '~/store';

/** Lets an attached stream deliver its own final event before the saved messages are read. */
const RESOLVE_DELAY_MS = 600;
/** Short runs finish before anyone could answer a question; only longer ones are checked. */
const PROBE_AFTER_MS = 10_000;
const PROBE_INTERVAL_MS = 20_000;

/**
 * Shared by every mounted list so one tab reads each transition once. `active` holds the job
 * ids of the last poll with the time this tab first saw them running.
 */
const tracker: {
  owner: object | null;
  active: Map<string, number> | null;
  probedAt: Map<string, number>;
  probing: Set<string>;
  resolving: Set<string>;
} = {
  owner: null,
  active: null,
  probedAt: new Map(),
  probing: new Set(),
  resolving: new Set(),
};

export function useConversationActivity(conversationId: string) {
  return useSyncExternalStore(
    subscribeActivity,
    useCallback(() => getConversationActivity(conversationId), [conversationId]),
    () => null,
  );
}

export function useActivityTracking() {
  const { conversationId: routeId } = useParams();
  const { index, conversation } = useChatContext();
  const submission = useRecoilValue(store.submissionByIndex(index));
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const conversationId = conversation?.conversationId ?? routeId ?? 'new';
  const activity = useConversationActivity(conversationId);
  const runId = activity?.runId;
  const messageId = activity?.messageId;
  const { data } = useGetMessagesByConvoId(
    conversationId,
    {
      enabled: conversationId !== 'new' && conversationId !== 'search',
      select: useCallback(
        (messages: TMessage[]) => ({
          identity: { runId, messageId },
          update: activityFromMessages(messages, messageId),
        }),
        [runId, messageId],
      ),
    },
    { isStreaming: isSubmitting },
  );
  useEffect(() => {
    if (index === 0) setViewedConversation(conversationId);
  }, [index, conversationId]);
  useEffect(() => {
    /** `useNewConvo` clears the submission to `{}` while `isSubmitting` may still be true. */
    if (isSubmitting && submission?.userMessage != null)
      beginConversationActivity(submission, conversationId, false);
    if (data) updateConversationActivity(conversationId, data.update, data.identity);
  }, [submission, isSubmitting, conversationId, data]);
  return { conversationId, activity };
}

/** Reads the outcome of a run that ended while no stream was attached to it. */
async function settleEndedJob(conversationId: string, activeSince: number) {
  const current = getConversationActivity(conversationId);
  if (isTerminalActivity(current) && current.updatedAt >= activeSince) return;
  try {
    const messages = await dataService.getMessagesByConvoId(conversationId);
    applyBackgroundActivity(conversationId, outcomeFromMessages(messages), current);
  } catch (error) {
    if (isNotFoundError(error)) applyBackgroundActivity(conversationId, null, current);
  }
}

function resolveEndedJob(conversationId: string, activeSince: number, queryClient: QueryClient) {
  if (conversationId === 'new' || tracker.resolving.has(conversationId)) return;
  tracker.resolving.add(conversationId);
  setTimeout(() => {
    settleEndedJob(conversationId, activeSince).finally(() => {
      tracker.resolving.delete(conversationId);
      void refreshConversationTitle(queryClient, conversationId);
    });
  }, RESOLVE_DELAY_MS);
}

/** A job waiting for approval or an answer stays active; only its status tells them apart. */
function probeActiveJob(conversationId: string) {
  if (tracker.probing.has(conversationId)) return;
  tracker.probing.add(conversationId);
  tracker.probedAt.set(conversationId, Date.now());
  const current = getConversationActivity(conversationId);
  fetchStreamStatus(conversationId)
    .then((status) => {
      if (!status.active || !tracker.active?.has(conversationId)) return;
      if (status.status === 'requires_action') {
        applyBackgroundActivity(
          conversationId,
          {
            state: 'needs-input',
            stage: 'question',
            messageId: status.pendingAction?.responseMessageId,
          },
          current,
        );
      } else if (current?.state === 'needs-input') {
        applyBackgroundActivity(conversationId, { state: 'running', stage: 'thinking' }, current);
      }
    })
    .catch(() => undefined)
    .finally(() => tracker.probing.delete(conversationId));
}

function trackActiveJobs(activeJobIds: string[], queryClient: QueryClient, viewedId?: string) {
  const now = Date.now();
  const previous = tracker.active;
  const next = new Map<string, number>();
  for (const id of activeJobIds) next.set(id, previous?.get(id) ?? now);
  tracker.active = next;

  const candidates = previous ? previous.keys() : getLiveConversationIds();
  for (const id of candidates) {
    if (!next.has(id)) resolveEndedJob(id, previous?.get(id) ?? 0, queryClient);
  }
  for (const id of tracker.probedAt.keys()) {
    if (!next.has(id)) tracker.probedAt.delete(id);
  }

  if (document.visibilityState === 'hidden') return;
  for (const [id, since] of next) {
    if (
      id !== viewedId &&
      now - since >= PROBE_AFTER_MS &&
      now - (tracker.probedAt.get(id) ?? 0) >= PROBE_INTERVAL_MS
    )
      probeActiveJob(id);
  }
}

/**
 * Keeps sidebar outcomes honest for conversations that run without an attached stream:
 * an ended job gets its saved outcome (done, question, error) and title, a paused job is
 * shown as waiting for input, and the open conversation counts as seen. Only conversations
 * that change state are read; any number of lists may mount it, one of them does the work.
 */
export function useBackgroundActivity(activeJobs?: ActiveJobsResponse) {
  const queryClient = useQueryClient();
  const { conversationId: routeId } = useParams();
  const ownerRef = useRef({});

  useEffect(() => {
    setViewedConversation(routeId ?? null);
  }, [routeId]);

  useEffect(() => {
    const owner = ownerRef.current;
    return () => {
      if (tracker.owner !== owner) return;
      tracker.owner = null;
      tracker.active = null;
      tracker.probedAt.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeJobs) return;
    if (!tracker.owner) tracker.owner = ownerRef.current;
    if (tracker.owner !== ownerRef.current) return;
    trackActiveJobs(activeJobs.activeJobIds ?? [], queryClient, routeId);
  }, [activeJobs, queryClient, routeId]);
}
