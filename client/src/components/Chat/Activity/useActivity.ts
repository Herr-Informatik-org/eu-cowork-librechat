import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import type { TMessage } from 'librechat-data-provider';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useChatContext } from '~/Providers';
import {
  subscribeActivity,
  getConversationActivity,
  beginConversationActivity,
  updateConversationActivity,
} from '~/store/activity';
import { activityFromMessages } from './model';
import store from '~/store';

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
    if (submission && isSubmitting) beginConversationActivity(submission, conversationId, false);
    if (data) updateConversationActivity(conversationId, data.update, data.identity);
  }, [submission, isSubmitting, conversationId, data]);
  return { conversationId, activity };
}
