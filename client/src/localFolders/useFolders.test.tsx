import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalFolderMenu from './menu';
import { createFolderReader } from './reader';
import { addLocalFolder, clearLocalFolders, getLocalFolders, setLocalFolderUser } from './store';

jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'user' } }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (
      ({
        com_ui_local_folders_connect: 'Lokalen Ordner verbinden',
        com_ui_local_folders_disconnect: 'Ordnerzugriff entfernen',
        com_ui_local_folders_none: 'Kein Ordner',
        com_ui_local_folders_open: 'Ordner öffnen…',
      }) as Record<string, string>
    )[key] ?? key,
}));
let mockLocalFoldersEnabled = true;
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { localFoldersEnabled: mockLocalFoldersEnabled } }),
}));
jest.mock('./reader', () => ({ createFolderReader: jest.fn() }));
const createReader = jest.mocked(createFolderReader);
const dispose = jest.fn();
const execute = jest.fn();
async function openMenu() {
  fireEvent.click(screen.getByTestId('local-folder-menu-button'));
  return screen.findByRole('menu');
}
async function connectFolder() {
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Ordner öffnen…' }));
}
const browser = window as Window & { showDirectoryPicker?: jest.Mock };
beforeEach(() => {
  clearLocalFolders();
  setLocalFolderUser('user');
  mockLocalFoldersEnabled = true;
  createReader.mockReturnValue({ dispose, execute });
});
afterEach(() => {
  delete browser.showDirectoryPicker;
  setLocalFolderUser(null);
});

it('requests read permission in the click handler and displays a removable grant', async () => {
  browser.showDirectoryPicker = jest.fn().mockResolvedValue({ name: 'Reports', kind: 'directory' });
  render(<LocalFolderMenu conversationId="chat" />);
  expect(screen.getByTestId('local-folder-menu-button')).toHaveTextContent('Kein Ordner');
  await connectFolder();
  expect(browser.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'read' });
  await waitFor(() =>
    expect(screen.getByTestId('local-folder-menu-button')).toHaveTextContent('Reports'),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(createReader).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Reports',
      handle: expect.objectContaining({ name: 'Reports' }),
    }),
  );
  await openMenu();
  const remove = screen.getByRole('menuitemcheckbox', { name: 'Ordnerzugriff entfernen: Reports' });
  expect(remove).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(remove);
  expect(getLocalFolders('user', 'chat')).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('uses directory file selection as a fallback without reading or uploading', async () => {
  render(<LocalFolderMenu conversationId="chat" />);
  await connectFolder();
  const input = screen.getByLabelText('Lokalen Ordner verbinden');
  expect(input).toHaveAttribute('webkitdirectory');
  const file = new File(['private contents'], 'note.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: 'Notes/note.txt' });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByTestId('local-folder-menu-button')).toHaveTextContent('Notes');
  expect(createReader).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'Notes', files: [file] }),
  );
  expect(execute).not.toHaveBeenCalled();
});

it('disposes a delayed picker result after logout', async () => {
  let resolve: (handle: { name: string }) => void = () => undefined;
  browser.showDirectoryPicker = jest.fn(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<LocalFolderMenu conversationId="chat" />);
  await connectFolder();
  act(() => setLocalFolderUser(null));
  await act(async () => resolve({ name: 'Late folder' }));
  await waitFor(() => expect(dispose).toHaveBeenCalled());
  expect(getLocalFolders('user', 'chat')).toEqual([]);
});

it('refuses an oversized fallback FileList before iterating or copying it', async () => {
  render(<LocalFolderMenu conversationId="chat" />);
  await connectFolder();
  const files = {
    length: 20001,
    [Symbol.iterator]: () => {
      throw new Error('Must not enumerate the oversized FileList');
    },
  };
  fireEvent.change(screen.getByLabelText('Lokalen Ordner verbinden'), { target: { files } });
  expect(screen.getByText('com_ui_local_folders_fallback_limit')).toBeInTheDocument();
  expect(createReader).not.toHaveBeenCalled();
});

it('removes every current-chat grant through Kein Ordner while preserving another chat', async () => {
  const otherDispose = jest.fn();
  for (const [id, label] of [
    ['first', 'Reports'],
    ['second', 'Invoices'],
  ]) {
    addLocalFolder('user', 'chat', { id, label }, { dispose, execute });
  }
  addLocalFolder(
    'user',
    'other',
    { id: 'other', label: 'Other chat' },
    { dispose: otherDispose, execute },
  );
  render(<LocalFolderMenu conversationId="chat" />);
  const trigger = screen.getByTestId('local-folder-menu-button');
  expect(trigger).toHaveTextContent('Reports+1');
  expect(screen.queryByText('verbunden')).not.toBeInTheDocument();
  await openMenu();
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Kein Ordner' }));
  expect(getLocalFolders('user', 'chat')).toEqual([]);
  expect(getLocalFolders('user', 'other')).toHaveLength(1);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(otherDispose).not.toHaveBeenCalled();
  expect(trigger).toHaveTextContent('Kein Ordner');
});

it('hides the folder menu when the startup flag is disabled', () => {
  mockLocalFoldersEnabled = false;
  render(<LocalFolderMenu conversationId="chat" />);
  expect(screen.queryByTestId('local-folder-menu-button')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Lokalen Ordner verbinden')).not.toBeInTheDocument();
});

it('hides connection controls when tools are unavailable and no grant exists', () => {
  render(<LocalFolderMenu conversationId="chat" available={false} />);
  expect(screen.queryByTestId('local-folder-menu-button')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Lokalen Ordner verbinden')).not.toBeInTheDocument();
});

it('allows revocation but no new connection when tools become unavailable', async () => {
  addLocalFolder('user', 'chat', { id: 'existing', label: 'Reports' }, { dispose, execute });
  render(<LocalFolderMenu conversationId="chat" available={false} />);
  await openMenu();
  expect(screen.queryByRole('menuitem', { name: 'Ordner öffnen…' })).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('menuitemcheckbox', { name: 'Ordnerzugriff entfernen: Reports' }),
  );
  expect(getLocalFolders('user', 'chat')).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('local-folder-menu-button')).not.toBeInTheDocument();
});
