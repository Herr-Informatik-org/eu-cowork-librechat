import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import {
  listChatDrafts,
  saveChatDraft,
  readChatDraft,
  removeChatDraft,
  setChatDraftOwner,
  requestDraftArchive,
  ARCHIVE_NEW_CHAT,
} from '../history';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
const content = (text = 'Grüezi Zürich') => ({ text, fileIds: [] });

test('keeps separate new chats, Unicode and a single-character message without overwriting', () => {
  const one = saveChatDraft('alice', content('Ä Ö Ü – Zürich'))!;
  const two = saveChatDraft('alice', content('X'))!;
  expect(one.id).not.toBe(two.id);
  expect(readChatDraft('alice', one.id)?.text).toBe('Ä Ö Ü – Zürich');
  expect(readChatDraft('alice', two.id)?.text).toBe('X');
  expect(listChatDrafts('alice')).toHaveLength(2);
});
test('never exposes another account’s drafts or interprets its URL id as ownership', () => {
  const one = saveChatDraft('alice', content())!;
  expect(listChatDrafts('bob')).toEqual([]);
  expect(readChatDraft('bob', one.id)).toBeNull();
  removeChatDraft('bob', one.id);
  expect(readChatDraft('alice', one.id)).not.toBeNull();
});
test('preserves attachments and only the whitelisted model/project setup', () => {
  const saved = saveChatDraft('alice', {
    text: '',
    fileIds: ['file-1', 'file-1'],
    setup: {
      spec: 'luna',
      model: 'model-a',
      chatProjectId: 'a'.repeat(24),
      providerCredential: 'synthetic-only',
    } as never,
  })!;
  expect(saved.fileIds).toEqual(['file-1']);
  expect(saved.setup).toEqual({ spec: 'luna', model: 'model-a', chatProjectId: 'a'.repeat(24) });
});
test('an existing draft retains its identity and creation date on edit', () => {
  const first = saveChatDraft('alice', content('Erster Stand'))!;
  const second = saveChatDraft('alice', { ...content('Neuer Stand'), id: first.id })!;
  expect(second.createdAt).toBe(first.createdAt);
  expect(listChatDrafts('alice')).toHaveLength(1);
  expect(readChatDraft('alice', first.id)?.text).toBe('Neuer Stand');
});
test('ignores whitespace-only empty drafts and rejects unsafe attachment identifiers', () => {
  expect(saveChatDraft('alice', content('  \n '))).toBeNull();
  expect(() => saveChatDraft('alice', { text: '', fileIds: ['../foreign-file'] })).toThrow();
  expect(listChatDrafts('alice')).toEqual([]);
});
test('does not silently truncate long text or evict existing drafts at the limit', () => {
  expect(() => saveChatDraft('alice', content('x'.repeat(100001)))).toThrow();
  for (let i = 0; i < 100; i++) saveChatDraft('alice', content('Entwurf ' + i));
  expect(() => saveChatDraft('alice', content('Zusätzlicher Entwurf'))).toThrow('100 Entwürfe');
  expect(listChatDrafts('alice')).toHaveLength(100);
});
test('a quota error does not alter an already saved draft', () => {
  const old = saveChatDraft('alice', content('Erhalten'))!;
  const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  expect(() => saveChatDraft('alice', content('Nicht speichern'))).toThrow();
  set.mockRestore();
  expect(readChatDraft('alice', old.id)?.text).toBe('Erhalten');
});
test('corrupt records are reported without being overwritten', () => {
  const old = saveChatDraft('alice', content())!;
  const key = Object.keys(localStorage).find((key) => key.endsWith(old.id))!;
  localStorage.setItem(key, '{');
  expect(() => listChatDrafts('alice')).toThrow('beschädigt');
  expect(localStorage.getItem(key)).toBe('{');
});
test('account changes clear the native new-chat buffer while retaining private archived records', () => {
  const saved = saveChatDraft('alice', content('Privat'))!;
  setChatDraftOwner('alice');
  localStorage.setItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO, 'private-buffer');
  localStorage.setItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO, '["private-file"]');
  setChatDraftOwner('bob');
  expect(localStorage.getItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO)).toBeNull();
  expect(localStorage.getItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO)).toBeNull();
  expect(listChatDrafts('bob')).toEqual([]);
  expect(readChatDraft('alice', saved.id)?.text).toBe('Privat');
});
test('saving can veto navigation when persistence fails', () => {
  const prevent = (event: Event) => event.preventDefault();
  window.addEventListener(ARCHIVE_NEW_CHAT, prevent);
  expect(requestDraftArchive()).toBe(false);
  window.removeEventListener(ARCHIVE_NEW_CHAT, prevent);
  expect(requestDraftArchive()).toBe(true);
});
