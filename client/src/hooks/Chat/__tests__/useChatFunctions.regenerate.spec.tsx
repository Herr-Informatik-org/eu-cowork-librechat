import { renderHook, act } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import useChatFunctions from '../useChatFunctions';
import type { ExtendedFile } from '~/common';

const mockNavigate = jest.fn();
const mockSetShowStopButton = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockGetEphemeralAgent = jest.fn(() => null);
const mockSetFilesToDelete = jest.fn();
const mockGetSender = jest.fn(() => 'Assistant');
const mockGetExpiry = jest.fn(() => 'expiry-key');
const mockGetQueryData = jest.fn(() => ({}));
const mockLoggerWarn = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: mockGetQueryData,
    getQueryState: jest.fn(() => undefined),
  }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useSetRecoilState: (atom: unknown) =>
    String(atom).includes('isSubmitting') ? mockSetIsSubmitting : mockSetShowStopButton,
  useRecoilCallback: (factory: any) =>
    factory({
      snapshot: {
        getLoadable: () => ({ state: 'hasValue', contents: [] }),
      },
      set: jest.fn(),
      reset: jest.fn(),
    }),
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => mockSetFilesToDelete);
jest.mock('~/hooks/Conversations/useGetSender', () => () => mockGetSender);
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: mockGetExpiry }));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: null }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: 'isTemporary',
    isSubmittingFamily: () => 'isSubmitting',
    showStopButtonByIndex: () => 'showStopButton',
    pendingManualSkillsByConvoId: () => 'pendingManualSkills',
    pendingQuotesByConvoId: () => 'pendingQuotes',
    messagesSiblingIdxFamily: () => 'messagesSiblingIdx',
  },
  useGetEphemeralAgent: () => mockGetEphemeralAgent,
}));
jest.mock('~/utils', () => ({
  logger: {
    log: jest.fn(),
    dir: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  createDualMessageContent: jest.fn(() => []),
  getRouteChatProjectId: jest.fn(() => null),
  requestChatFocus: jest.fn(),
  hasStreamStartFailed: jest.fn(() => false),
}));

const userMessage = (messageId: string, parentMessageId = '00000000-0000-0000-0000-000000000000') =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    sender: 'User',
    text: messageId,
  }) as TMessage;

const assistantMessage = (messageId: string, parentMessageId: string) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: false,
    sender: 'Assistant',
    text: messageId,
  }) as TMessage;

const conversation = (conversationId: string) =>
  ({
    conversationId,
    endpoint: EModelEndpoint.agents,
    model: 'gpt-4o',
    agent_id: 'agent-1',
  }) as TConversation;

function renderAsk(
  messages: TMessage[] | undefined,
  conversationId = 'conversation-1',
  options: {
    endpoint?: TConversation['endpoint'];
    isSubmitting?: boolean;
    files?: Map<string, ExtendedFile>;
  } = {},
) {
  const setMessages = jest.fn();
  const setSubmission = jest.fn();
  const setFiles = jest.fn();
  const getMessages = jest.fn(() => messages);
  const immutableConversation = conversation(conversationId);
  if ('endpoint' in options) {
    immutableConversation.endpoint = options.endpoint ?? null;
  }
  const hook = renderHook(() =>
    useChatFunctions({
      isSubmitting: options.isSubmitting ?? false,
      files: options.files,
      setFiles,
      latestMessage: messages?.at(-1) ?? null,
      conversation: immutableConversation,
      getMessages,
      setMessages,
      setSubmission,
    }),
  );

  return { ...hook, getMessages, setMessages, setSubmission, setFiles };
}

describe('useChatFunctions ask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryData.mockReturnValue({});
  });

  it('refuses to send to an existing conversation before its history loads', () => {
    const { result, getMessages, setMessages, setSubmission } = renderAsk(undefined);

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'Hello', conversationId: 'conversation-1' });
    });

    expect(askResult!).toBe(false);
    expect(getMessages).toHaveBeenCalledWith('conversation-1');
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[useChatFunctions] Refusing to send before existing conversation history loads',
    );
  });

  it('synchronously reports a refusal while another submit is in flight', () => {
    const { result, setMessages, setSubmission } = renderAsk([], 'conversation-1', {
      isSubmitting: true,
    });

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'queued follow-up' });
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockSetShowStopButton).not.toHaveBeenCalled();
  });

  it('reports a refusal when no endpoint is available', () => {
    const { result, setMessages, setSubmission } = renderAsk([], 'conversation-1', {
      endpoint: null,
    });

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'queued follow-up' });
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockSetShowStopButton).not.toHaveBeenCalled();
  });

  it.each([
    ['empty text', { text: '   ' }, undefined],
    ['the search view', { text: 'queued follow-up', conversationId: 'search' }, undefined],
    ['a continue without a latest message', { text: 'continue' }, { isContinued: true }],
  ])('reports a refusal for %s', (_label, props, askOptions) => {
    const { result, setMessages, setSubmission } = renderAsk([]);

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask(props, askOptions);
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
  });

  it('allows an existing conversation whose loaded history is empty', () => {
    const { result, setMessages, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'Hello', conversationId: 'conversation-1' });
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });

  it('allows a new conversation before its message cache exists', () => {
    const newConversationId = Constants.NEW_CONVO as string;
    const { result, setMessages, setSubmission } = renderAsk(undefined, newConversationId);

    act(() => {
      result.current.ask({ text: 'Hello', conversationId: newConversationId });
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });

  it('allows explicit override messages before the cache exists', () => {
    const { result, setMessages, setSubmission } = renderAsk(undefined);

    act(() => {
      result.current.ask(
        { text: 'Hello', conversationId: 'conversation-1' },
        { overrideMessages: [] },
      );
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });
});

describe('useChatFunctions regenerate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryData.mockReturnValue({});
  });

  it('keys a non-tail regenerate to the selected assistant response', () => {
    let messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];
    const setMessages = jest.fn((nextMessages: TMessage[]) => {
      messages = nextMessages;
    });
    const setSubmission = jest.fn();
    const conversation = {
      conversationId: 'conversation-1',
      endpoint: EModelEndpoint.agents,
      model: 'gpt-4o',
      agent_id: 'agent-1',
    } as TConversation;

    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: messages[5],
        conversation,
        getMessages: () => messages,
        setMessages,
        setSubmission,
      }),
    );

    act(() => {
      result.current.regenerate(messages[1]);
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.overrideParentMessageId).toBe('user-1');
    expect(submission.userMessage.responseMessageId).toBe('assistant-1_');
    expect(submission.initialResponse?.messageId).toBe('assistant-1_');
    expect(submission.initialResponse?.parentMessageId).toBe('user-1');
    expect(submission.messages.map((message) => message.messageId)).toEqual(['user-1']);
    expect(submission.regenerateMessages?.map((message) => message.messageId)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
      'user-3',
      'assistant-3',
    ]);
    expect(
      setMessages.mock.calls.at(-1)?.[0].map((message: TMessage) => message.messageId),
    ).toEqual(['user-1', 'assistant-1_']);
    expect(messages.at(-1)?.messageId).toBe('assistant-1_');
  });
});

describe('image-only submissions', () => {
  const image: ExtendedFile = {
    file_id: 'image-one',
    type: 'image/png',
    filepath: '/images/image.png',
    size: 120,
    progress: 1,
  };
  const history = [userMessage('user-1'), assistantMessage('assistant-1', 'user-1')];

  it('submits an image with empty text and preserves the current support conversation', () => {
    const { result, setSubmission, setFiles } = renderAsk(history, 'conversation-1', {
      files: new Map([[image.file_id, image]]),
    });
    act(() => {
      result.current.ask({ text: '   ' });
    });
    expect(setSubmission).toHaveBeenCalledTimes(1);
    const submission: TSubmission = setSubmission.mock.calls[0][0];
    expect(submission.userMessage).toMatchObject({
      text: '',
      parentMessageId: 'assistant-1',
      conversationId: 'conversation-1',
      files: [expect.objectContaining({ file_id: image.file_id })],
    });
    expect(submission.messages.slice(0, 2)).toEqual(history);
    expect(setFiles).toHaveBeenCalledWith(new Map());
  });

  it('starts a new conversation with an image and no text', () => {
    const { result, setSubmission } = renderAsk(undefined, Constants.NEW_CONVO, {
      files: new Map([[image.file_id, image]]),
    });
    act(() => {
      result.current.ask({ text: '' });
    });
    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect(setSubmission.mock.calls[0][0].userMessage).toMatchObject({
      text: '',
      files: [expect.objectContaining({ file_id: image.file_id })],
    });
  });

  it('does not consume an image while its upload is pending', () => {
    const { result, setSubmission, setFiles } = renderAsk(history, 'conversation-1', {
      files: new Map([[image.file_id, { ...image, progress: 0.5 }]]),
    });
    act(() => {
      expect(result.current.ask({ text: '' })).toBe(false);
    });
    expect(setSubmission).not.toHaveBeenCalled();
    expect(setFiles).not.toHaveBeenCalled();
  });

  it('respects explicit empty overrides instead of using unrelated composer images', () => {
    const { result, setSubmission, setFiles } = renderAsk(history, 'conversation-1', {
      files: new Map([[image.file_id, image]]),
    });
    act(() => {
      expect(result.current.ask({ text: '' }, { overrideFiles: [] })).toBe(false);
    });
    expect(setSubmission).not.toHaveBeenCalled();
    expect(setFiles).not.toHaveBeenCalled();
  });

  it('accepts an explicit image override without consuming the composer draft', () => {
    const { result, setSubmission, setFiles } = renderAsk(history);
    act(() => {
      result.current.ask({ text: '' }, { overrideFiles: [image] });
    });
    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect(setSubmission.mock.calls[0][0].userMessage.files).toEqual([image]);
    expect(setFiles).not.toHaveBeenCalled();
  });

  it('regenerates the response to an image-only message using its saved attachment', () => {
    const original = { ...userMessage('user-1'), text: '', files: [image] };
    const { result, setSubmission } = renderAsk([
      original,
      assistantMessage('assistant-1', 'user-1'),
    ]);
    act(() => {
      result.current.regenerate(assistantMessage('assistant-1', 'user-1'));
    });
    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect(setSubmission.mock.calls[0][0].userMessage.files).toEqual([image]);
  });
});
