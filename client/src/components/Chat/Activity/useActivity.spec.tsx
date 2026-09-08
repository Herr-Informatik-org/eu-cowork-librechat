import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, QueryKeys, StepEvents, StepTypes } from 'librechat-data-provider';
import type { EventSubmission, TMessage } from 'librechat-data-provider';
import useStepHandler from '~/hooks/SSE/useStepHandler';
import {
  beginConversationActivity,
  clearConversationActivities,
  getConversationActivity,
  setConversationActivityUser,
} from '~/store/activity';
import store from '~/store';
import { useActivityTracking } from './useActivity';

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ index: 0, conversation: { conversationId: 'activity-chat' } }),
}));
jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: jest.requireActual('~/data-provider/Messages/queries')
    .useGetMessagesByConvoId,
}));

const userMessage: TMessage = {
  messageId: 'user-message',
  conversationId: 'activity-chat',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Hello',
};
const placeholder: TMessage = {
  ...userMessage,
  messageId: 'optimistic-response',
  parentMessageId: userMessage.messageId,
  isCreatedByUser: false,
  text: '',
  content: [],
};
const submission = {
  clientRequestId: 'activity-request',
  conversation: { conversationId: 'activity-chat' },
  userMessage,
  initialResponse: placeholder,
  messages: [],
  endpointOption: { endpoint: 'custom' },
  isTemporary: false,
} as EventSubmission;

function setup(messages = [userMessage, placeholder]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const key = [QueryKeys.messages, 'activity-chat'];
  queryClient.setQueryData(key, messages);
  beginConversationActivity(submission);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/c/activity-chat']}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.submissionByIndex(0), submission);
            set(store.isSubmittingFamily(0), true);
          }}
        >
          {children}
        </RecoilRoot>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      tracker: useActivityTracking(),
      sse: useStepHandler({
        getMessages: () => queryClient.getQueryData<TMessage[]>(key),
        setMessages: (next) => queryClient.setQueryData(key, next),
        announcePolite: jest.fn(),
        lastAnnouncementTimeRef: { current: Date.now() },
      }),
    }),
    { wrapper },
  );
  return { ...hook, queryClient, key };
}

beforeEach(() => {
  setConversationActivityUser('activity-test-user');
  clearConversationActivities();
});

test('SSE response replacement and a real text delta change waiting to writing', async () => {
  const { result, queryClient, key, unmount } = setup();
  expect(result.current.tracker.activity?.stage).toBe('waiting');
  act(() => {
    result.current.sse.stepHandler(
      {
        event: StepEvents.ON_RUN_STEP,
        data: {
          id: 'step-one',
          runId: 'server-response',
          index: 0,
          type: StepTypes.MESSAGE_CREATION,
          stepDetails: {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: 'server-response' },
          },
          usage: null,
        },
      },
      submission,
    );
    result.current.sse.stepHandler(
      {
        event: StepEvents.ON_MESSAGE_DELTA,
        data: {
          id: 'step-one',
          delta: { content: [{ type: ContentTypes.TEXT, text: 'Live answer' }] },
        },
      },
      submission,
    );
    result.current.sse.flushPendingDeltas();
  });

  expect(queryClient.getQueryData<TMessage[]>(key)?.at(-1)).toMatchObject({
    messageId: 'server-response',
    content: [{ type: ContentTypes.TEXT, text: 'Live answer' }],
  });
  await waitFor(() =>
    expect(result.current.tracker.activity).toMatchObject({
      messageId: 'server-response',
      state: 'running',
      stage: 'writing',
    }),
  );
  unmount();
  queryClient.clear();
});

test('an authoritative response identity change reselects an unchanged query cache', async () => {
  const serverResponse = { ...placeholder, messageId: 'server-response', text: 'Already cached' };
  const { result, queryClient, key, unmount } = setup([userMessage, serverResponse]);
  const before = queryClient.getQueryData(key);
  expect(result.current.tracker.activity?.stage).toBe('waiting');

  act(() => beginConversationActivity(submission, 'activity-chat', false, 'server-response'));

  await waitFor(() => expect(result.current.tracker.activity?.stage).toBe('writing'));
  expect(queryClient.getQueryData(key)).toBe(before);
  expect(getConversationActivity('activity-chat')?.messageId).toBe('server-response');
  unmount();
  queryClient.clear();
});

test('a later historical branch cannot become the active response', () => {
  const oldBranch = { ...placeholder, messageId: 'old-branch', text: 'Old completed answer' };
  const { result, queryClient, unmount } = setup([userMessage, placeholder, oldBranch]);

  expect(result.current.tracker.activity).toMatchObject({
    messageId: 'optimistic-response',
    state: 'waiting',
  });
  unmount();
  queryClient.clear();
});
