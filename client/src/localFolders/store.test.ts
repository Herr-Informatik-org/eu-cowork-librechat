import type { LocalFolderResult } from 'librechat-data-provider';
import {
  addLocalFolder,
  clearLocalFolders,
  executeLocalFolder,
  getLocalFolders,
  getLocalFolderSession,
  removeLocalFolder,
  setLocalFolderUser,
  transferLocalFolders,
  withLocalFolders,
} from './store';

const result: LocalFolderResult = {
  status: 'ok',
  text: 'bounded excerpt',
  coverage: { complete: true, filesVisited: 1, filesRead: 1, bytesRead: 15, skipped: 0 },
};
const reader = () => ({ execute: jest.fn().mockResolvedValue(result), dispose: jest.fn() });

beforeEach(() => {
  clearLocalFolders();
  setLocalFolderUser('user-a');
});
afterEach(() => setLocalFolderUser(null));

it('isolates grants by account and chat, exposing metadata only', () => {
  const local = reader();
  addLocalFolder('user-a', 'chat-a', { id: 'folder-a', label: 'Reports' }, local);
  expect(getLocalFolders('user-b', 'chat-a')).toEqual([]);
  expect(getLocalFolders('user-a', 'chat-b')).toEqual([]);
  expect(
    withLocalFolders(
      { memory: true, localFolders: [{ id: 'stale', label: 'Old' }] },
      'user-a',
      'chat-a',
      true,
    ),
  ).toEqual({ memory: true, localFolders: [{ id: 'folder-a', label: 'Reports' }] });
  expect(
    withLocalFolders({ localFolders: [{ id: 'stale', label: 'Old' }] }, 'user-a', 'chat-a', false),
  ).toBeNull();
  expect(local.execute).not.toHaveBeenCalled();
});

it('moves only the grants submitted with an acknowledged new chat', () => {
  addLocalFolder('user-a', 'new', { id: 'submitted', label: 'First' }, reader());
  addLocalFolder('user-a', 'new', { id: 'later', label: 'Second' }, reader());
  transferLocalFolders('user-a', 'created-chat', ['submitted']);
  transferLocalFolders('user-a', 'created-chat', ['submitted']);
  expect(getLocalFolders('user-a', 'created-chat').map((folder) => folder.id)).toEqual([
    'submitted',
  ]);
  expect(getLocalFolders('user-a', 'new').map((folder) => folder.id)).toEqual(['later']);
});

it('rejects a picker resolving after account change and limits grants to three', () => {
  const oldSession = getLocalFolderSession();
  setLocalFolderUser('user-b');
  setLocalFolderUser('user-a');
  const stale = reader();
  expect(addLocalFolder('user-a', 'chat', { id: 'old', label: 'Old' }, stale, oldSession)).toBe(
    false,
  );
  expect(stale.dispose).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 3; index++)
    expect(addLocalFolder('user-a', 'chat', { id: String(index), label: 'Folder' }, reader())).toBe(
      true,
    );
  const extra = reader();
  expect(addLocalFolder('user-a', 'chat', { id: 'extra', label: 'Extra' }, extra)).toBe(false);
  expect(extra.dispose).toHaveBeenCalled();
});

it('bounds retained folder readers across all chats in a tab', () => {
  for (let index = 0; index < 12; index++) {
    expect(
      addLocalFolder(
        'user-a',
        `chat-${index}`,
        { id: `folder-${index}`, label: 'Folder' },
        reader(),
      ),
    ).toBe(true);
  }
  const extra = reader();
  expect(addLocalFolder('user-a', 'another-chat', { id: 'extra', label: 'Extra' }, extra)).toBe(
    false,
  );
  expect(extra.dispose).toHaveBeenCalledTimes(1);
});

it.each(['disconnect', 'logout', 'pagehide'])(
  'aborts reading and clears access on %s',
  async (operation) => {
    let signal: AbortSignal | undefined;
    let resolve: (value: LocalFolderResult) => void = () => undefined;
    const local = {
      dispose: jest.fn(),
      execute: jest.fn((_request, nextSignal) => {
        signal = nextSignal;
        return new Promise<LocalFolderResult>((done) => {
          resolve = done;
        });
      }),
    };
    addLocalFolder('user-a', 'chat', { id: 'folder', label: 'Folder' }, local);
    const pending = executeLocalFolder('user-a', 'chat', {
      folderId: 'folder',
      operation: 'read',
      maxChars: 16000,
    });
    if (operation === 'disconnect') removeLocalFolder('user-a', 'chat', 'folder');
    if (operation === 'logout') setLocalFolderUser(null);
    if (operation === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    expect(signal?.aborted).toBe(true);
    expect(local.dispose).toHaveBeenCalled();
    expect(getLocalFolders('user-a', 'chat')).toEqual([]);
    resolve(result);
    await expect(pending).rejects.toThrow();
  },
);
