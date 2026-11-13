import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import DraftHistory from '../DraftHistory';
import { readChatDraft, saveChatDraft } from '../history';

let mockUser = { id: 'alice' };
const mockNewConversation = jest.fn();
jest.mock('recoil', () => ({ useRecoilValue: () => true }));
jest.mock('~/store', () => ({ __esModule: true, default: { saveDrafts: {} } }));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockUser = { id: 'alice' };
  mockNewConversation.mockClear();
  window.history.replaceState(null, '', '/c/new');
});
test('lists an unsent chat explicitly as a draft and restores its model and attachments', () => {
  const draft = saveChatDraft('alice', {
    text: 'Vorbereitung fürs Kundengespräch',
    fileIds: ['file-1'],
    setup: { spec: 'luna' },
  })!;
  render(<DraftHistory toggleNav={jest.fn()} />);
  expect(screen.getByText('Entwurf · 1 Anhänge')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Vorbereitung fürs Kundengespräch/ }));
  expect(mockNewConversation).toHaveBeenCalledWith({
    template: { spec: 'luna' },
    preset: { spec: 'luna' },
    restoreDraftId: draft.id,
  });
  expect(
    JSON.parse(localStorage.getItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO)!),
  ).toEqual(['file-1']);
});
test('account switching never renders the preceding account’s private draft', () => {
  saveChatDraft('alice', { text: 'Vertraulicher Entwurf Alice', fileIds: [] });
  const { rerender } = render(<DraftHistory toggleNav={jest.fn()} />);
  expect(screen.getByText('Vertraulicher Entwurf Alice')).toBeInTheDocument();
  act(() => {
    mockUser = { id: 'bob' };
    rerender(<DraftHistory toggleNav={jest.fn()} />);
  });
  expect(screen.queryByText('Vertraulicher Entwurf Alice')).not.toBeInTheDocument();
});
test('deletion requires the user’s explicit confirmation', () => {
  const draft = saveChatDraft('alice', { text: 'Diesen Entwurf prüfen', fileIds: [] })!;
  render(<DraftHistory toggleNav={jest.fn()} />);
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Entwurf löschen' }));
  expect(readChatDraft('alice', draft.id)).not.toBeNull();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Entwurf löschen' }));
  expect(readChatDraft('alice', draft.id)).toBeNull();
});

test('selecting the already open draft keeps the composer and avoids another new-chat reset', () => {
  saveChatDraft('alice', { text: 'Aktueller Entwurf', fileIds: [] });
  render(<DraftHistory toggleNav={jest.fn()} />);
  const button = screen.getByRole('button', { name: /Aktueller Entwurf/ });
  fireEvent.click(button);
  expect(mockNewConversation).toHaveBeenCalledTimes(1);
  fireEvent.click(button);
  expect(mockNewConversation).toHaveBeenCalledTimes(1);
});
