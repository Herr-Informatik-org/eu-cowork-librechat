import { act, renderHook } from '@testing-library/react';
import { useRecoilValue } from 'recoil';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import useCurrentChatDraft from '../useCurrentChatDraft';
import { listChatDrafts, saveChatDraft, requestDraftArchive, selectChatDraft } from '../history';
import store from '~/store';

jest.mock('recoil', () => ({ useRecoilValue: jest.fn() }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { user: { key: 'draft-user' }, saveDrafts: { key: 'draft-setting' } },
}));
jest.mock('~/Providers', () => ({ useChatFormContext: () => ({ setValue: mockSetValue }) }));
jest.mock('~/data-provider', () => ({ useGetFiles: () => ({ data: mockFiles }) }));
jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(global.window.location.search), jest.fn()],
}));
let mockFiles: unknown[] = [];
let mockOwner = 'alice';
let mockEnabled = true;
const mockSetValue = jest.fn();
const defaultProps = () => ({
  index: 0,
  conversation: {
    conversationId: Constants.NEW_CONVO,
    endpoint: EModelEndpoint.custom,
    model: 'luna',
    title: 'Neuer Chat',
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z',
  } as TConversation,
  isSubmitting: false,
  isTemporary: false,
  answerDraftId: null as string | null,
  textAreaRef: { current: document.createElement('textarea') },
  files: new Map(),
  setFiles: jest.fn(),
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/c/new');
  mockFiles = [];
  mockOwner = 'alice';
  mockEnabled = true;
  mockSetValue.mockReset();
  (useRecoilValue as jest.Mock).mockImplementation((atom) =>
    atom === store.user ? { id: mockOwner } : mockEnabled,
  );
});
test('archives the current text synchronously before a second new chat and empties the composer', () => {
  const props = defaultProps();
  props.textAreaRef.current.value = 'Noch nicht gesendet';
  renderHook(() => useCurrentChatDraft(props));
  act(() => {
    expect(requestDraftArchive()).toBe(true);
  });
  expect(listChatDrafts('alice')[0].text).toBe('Noch nicht gesendet');
  expect(props.textAreaRef.current.value).toBe('');
  expect(props.setFiles).toHaveBeenCalledWith(new Map());
});
test('repeated new chats retain separate drafts', () => {
  const props = defaultProps();
  renderHook(() => useCurrentChatDraft(props));
  for (const text of ['Erster Entwurf', 'Zweiter Entwurf'])
    act(() => {
      props.textAreaRef.current.value = text;
      requestDraftArchive();
    });
  expect(
    listChatDrafts('alice')
      .map((row) => row.text)
      .sort(),
  ).toEqual(['Erster Entwurf', 'Zweiter Entwurf']);
});
test('quota failure vetoes the new-chat transition and keeps text and files', () => {
  const props = defaultProps();
  props.textAreaRef.current.value = 'Darf nicht verloren gehen';
  renderHook(() => useCurrentChatDraft(props));
  const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  act(() => {
    expect(requestDraftArchive()).toBe(false);
  });
  expect(props.textAreaRef.current.value).toBe('Darf nicht verloren gehen');
  expect(props.setFiles).not.toHaveBeenCalled();
  write.mockRestore();
});
test.each([
  ['temporary', true, true],
  ['disabled', false, false],
])('%s chats are cleared without being archived', (_label, temporary, enabled) => {
  mockEnabled = enabled;
  const props = defaultProps();
  props.isTemporary = temporary;
  props.textAreaRef.current.value = 'Privater Text';
  renderHook(() => useCurrentChatDraft(props));
  act(() => {
    requestDraftArchive();
  });
  expect(listChatDrafts('alice')).toEqual([]);
  expect(props.textAreaRef.current.value).toBe('');
});
test('never saves a live run or its answer-to-question field as a new chat', () => {
  const props = defaultProps();
  props.answerDraftId = 'ask-answer:private';
  props.textAreaRef.current.value = 'Antwort zur laufenden Frage';
  renderHook(() => useCurrentChatDraft(props));
  act(() => {
    requestDraftArchive();
  });
  expect(listChatDrafts('alice')).toEqual([]);
  expect(props.textAreaRef.current.value).toBe('Antwort zur laufenden Frage');
});
test('restores only the current owner’s draft and does not overwrite typing on a later file refresh', () => {
  const draft = saveChatDraft('alice', { text: 'Gespeichert', fileIds: [] })!;
  window.history.replaceState(null, '', '/c/new?draft=' + draft.id);
  const props = defaultProps();
  const { rerender } = renderHook(() => useCurrentChatDraft(props));
  expect(mockSetValue).toHaveBeenCalledWith('text', 'Gespeichert');
  mockSetValue.mockClear();
  mockFiles = [{ file_id: 'unrelated', bytes: 2 }];
  rerender();
  expect(mockSetValue).not.toHaveBeenCalled();
});
test('a draft id from another account cannot restore its text', () => {
  const draft = saveChatDraft('alice', { text: 'Nur Alice', fileIds: [] })!;
  mockOwner = 'bob';
  window.history.replaceState(null, '', '/c/new?draft=' + draft.id);
  const props = defaultProps();
  renderHook(() => useCurrentChatDraft(props));
  expect(mockSetValue).not.toHaveBeenCalled();
});

test('editing a restored draft keeps one identity when native navigation removes the query parameter', () => {
  const draft = saveChatDraft('alice', { text: 'Original', fileIds: [] })!;
  selectChatDraft('alice', draft.id);
  const props = defaultProps();
  renderHook(() => useCurrentChatDraft(props));
  props.textAreaRef.current.value = 'Bearbeiteter Entwurf';
  act(() => {
    requestDraftArchive();
  });
  expect(listChatDrafts('alice')).toHaveLength(1);
  expect(listChatDrafts('alice')[0]).toMatchObject({ id: draft.id, text: 'Bearbeiteter Entwurf' });
});

test('leaving an unsent new chat archives it before another conversation replaces the form', () => {
  const props = defaultProps();
  props.textAreaRef.current.value = 'Vor dem Wechsel behalten';
  const { rerender } = renderHook((input) => useCurrentChatDraft(input), { initialProps: props });
  act(() => {
    rerender({
      ...props,
      conversation: { ...props.conversation, conversationId: 'existing-conversation' },
    });
  });
  expect(listChatDrafts('alice')).toHaveLength(1);
  expect(listChatDrafts('alice')[0].text).toBe('Vor dem Wechsel behalten');
});
