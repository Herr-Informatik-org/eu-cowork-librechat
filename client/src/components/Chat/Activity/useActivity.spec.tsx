import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContentTypes, QueryKeys, StepEvents, StepTypes } from 'librechat-data-provider';
import type { EventSubmission, TMessage, TSubmission } from 'librechat-data-provider';
import type { ActiveJobsResponse } from '~/data-provider';
import useStepHandler from '~/hooks/SSE/useStepHandler';
import {
  setViewedConversation,
  getConversationActivity,
  beginConversationActivity,
  finishConversationActivity,
  clearConversationActivities,
  setConversationActivityUser,
} from '~/store/activity';
import { applyPendingAction } from '~/utils/approval';
import { useActivityTracking, useBackgroundActivity } from './useActivity';
import store from '~/store';

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ index: 0, conversation: { conversationId: 'activity-chat' } }),
}));
const mockGetMessages = jest.fn();
const mockFetchStreamStatus = jest.fn();
const mockRefreshConversationTitle = jest.fn<Promise<void>, unknown[]>(() => Promise.resolve());
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: unknown[]) => mockGetMessages(...args),
    },
  };
});
jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: jest.requireActual('~/data-provider/Messages/queries')
    .useGetMessagesByConvoId,
  fetchStreamStatus: (...args: unknown[]) => mockFetchStreamStatus(...args),
  refreshConversationTitle: (...args: unknown[]) => mockRefreshConversationTitle(...args),
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

function setup(
  messages = [userMessage, placeholder],
  activeSubmission: TSubmission | EventSubmission = submission,
) {
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
            set(store.submissionByIndex(0), activeSubmission);
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
  setViewedConversation(null);
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

test('a submission cleared by a new chat while still submitting does not start a run', () => {
  clearConversationActivities();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData([QueryKeys.messages, 'activity-chat'], [userMessage]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/c/activity-chat']}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.submissionByIndex(0), {} as TSubmission);
            set(store.isSubmittingFamily(0), true);
          }}
        >
          {children}
        </RecoilRoot>
      </MemoryRouter>
    </QueryClientProvider>
  );

  const { result, unmount } = renderHook(() => useActivityTracking(), { wrapper });

  expect(result.current.activity).toBeNull();
  expect(getConversationActivity('activity-chat')).toBeNull();
  unmount();
  queryClient.clear();
});

describe('useBackgroundActivity', () => {
  const answered: TMessage = { ...placeholder, messageId: 'saved-answer', text: 'Saved answer' };

  function track(initial: ActiveJobsResponse | undefined, path = '/c/other-chat') {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/c/:conversationId" element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const hook = renderHook(
      ({ jobs }: { jobs?: ActiveJobsResponse }) => useBackgroundActivity(jobs),
      { wrapper, initialProps: { jobs: initial } },
    );
    const poll = (activeJobIds: string[]) => hook.rerender({ jobs: { activeJobIds } });
    return { ...hook, poll, queryClient };
  }

  const settle = (ms = 600) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetMessages.mockReset();
    mockFetchStreamStatus.mockReset();
    mockRefreshConversationTitle.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a chat that finishes in the background reports its saved outcome and title', async () => {
    mockGetMessages.mockResolvedValue([userMessage, answered]);
    const { poll, queryClient } = track({ activeJobIds: ['bg-done'] });

    poll([]);
    await settle();

    expect(mockGetMessages).toHaveBeenCalledTimes(1);
    expect(mockGetMessages).toHaveBeenCalledWith('bg-done');
    expect(getConversationActivity('bg-done')).toMatchObject({ state: 'done' });
    expect(getConversationActivity('bg-done')?.seen).toBeUndefined();
    expect(mockRefreshConversationTitle).toHaveBeenCalledWith(queryClient, 'bg-done');
  });

  test('chats that keep running are not read again', async () => {
    const { poll } = track({ activeJobIds: ['bg-running'] });
    poll(['bg-running']);
    poll(['bg-running']);
    await settle();
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(mockRefreshConversationTitle).not.toHaveBeenCalled();
  });

  test('an outcome already delivered by the attached stream is not read again', async () => {
    const attached = { ...submission, conversation: { conversationId: 'bg-attached' } };
    const { poll } = track({ activeJobIds: ['bg-attached'] });
    beginConversationActivity(attached);
    finishConversationActivity(attached, { final: true, responseMessage: answered });

    poll([]);
    await settle();

    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(getConversationActivity('bg-attached')?.state).toBe('done');
  });

  test('a saved open question stays a request for input', async () => {
    const asking = applyPendingAction(answered, {
      actionId: 'ask-bg',
      streamId: 'bg-question',
      createdAt: 0,
      payload: { type: 'ask_user_question', question: { question: 'Which client?' } },
    });
    mockGetMessages.mockResolvedValue([userMessage, asking]);
    const { poll } = track({ activeJobIds: ['bg-question'] });

    poll([]);
    await settle();

    expect(getConversationActivity('bg-question')?.state).toBe('needs-input');
  });

  test('a chat that finishes while it is open is not announced as new', async () => {
    mockGetMessages.mockResolvedValue([userMessage, answered]);
    const { poll } = track({ activeJobIds: ['bg-open'] }, '/c/bg-open');

    poll([]);
    await settle();

    expect(getConversationActivity('bg-open')).toMatchObject({ state: 'done', seen: true });
  });

  test('opening a finished chat marks it seen', async () => {
    mockGetMessages.mockResolvedValue([userMessage, answered]);
    const { poll } = track({ activeJobIds: ['bg-later'] });
    poll([]);
    await settle();
    expect(getConversationActivity('bg-later')?.seen).toBeUndefined();

    act(() => setViewedConversation('bg-later'));

    expect(getConversationActivity('bg-later')?.seen).toBe(true);
  });

  test('several mounted lists read each finished chat only once', async () => {
    mockGetMessages.mockResolvedValue([userMessage, answered]);
    const first = track({ activeJobIds: ['bg-shared'] });
    const second = track({ activeJobIds: ['bg-shared'] });

    first.poll([]);
    second.poll([]);
    await settle();

    expect(mockGetMessages).toHaveBeenCalledTimes(1);
  });

  test('a run observed before the list mounted is settled on the first poll', async () => {
    mockGetMessages.mockResolvedValue([userMessage, answered]);
    beginConversationActivity({ ...submission, conversation: { conversationId: 'bg-left' } });

    track({ activeJobIds: [] });
    await settle();

    expect(mockGetMessages).toHaveBeenCalledWith('bg-left');
    expect(getConversationActivity('bg-left')?.state).toBe('done');
  });

  test('a deleted chat forgets its run', async () => {
    mockGetMessages.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    beginConversationActivity({ ...submission, conversation: { conversationId: 'bg-gone' } });
    const { poll } = track({ activeJobIds: ['bg-gone'] });

    poll([]);
    await settle();

    expect(getConversationActivity('bg-gone')).toBeNull();
  });

  test('a long job paused for approval shows a request for input', async () => {
    mockFetchStreamStatus.mockResolvedValue({ active: true, status: 'requires_action' });
    const { poll } = track({ activeJobIds: ['bg-paused'] });

    poll(['bg-paused']);
    await settle(0);
    expect(mockFetchStreamStatus).not.toHaveBeenCalled();

    await settle(10_000);
    poll(['bg-paused']);
    await settle(0);

    expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
    expect(getConversationActivity('bg-paused')?.state).toBe('needs-input');

    mockFetchStreamStatus.mockResolvedValue({ active: true, status: 'running' });
    poll(['bg-paused']);
    await settle(0);
    expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);

    await settle(20_000);
    poll(['bg-paused']);
    await settle(0);
    expect(mockFetchStreamStatus).toHaveBeenCalledTimes(2);
    expect(getConversationActivity('bg-paused')?.state).toBe('running');
  });

  test('the open chat and a hidden window are never probed', async () => {
    mockFetchStreamStatus.mockResolvedValue({ active: true, status: 'requires_action' });
    const { poll } = track({ activeJobIds: ['bg-viewed', 'bg-hidden'] }, '/c/bg-viewed');
    const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    await settle(10_000);
    poll(['bg-viewed', 'bg-hidden']);
    await settle(0);
    expect(mockFetchStreamStatus).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    poll(['bg-viewed', 'bg-hidden']);
    await settle(0);
    expect(mockFetchStreamStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchStreamStatus).toHaveBeenCalledWith('bg-hidden');
    visibility.mockRestore();
  });
});
