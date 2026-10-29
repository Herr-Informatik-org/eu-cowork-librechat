import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalFolderBadges, useFolderPicker } from './useFolders';
import { createFolderReader } from './reader';
import { clearLocalFolders, getLocalFolders, setLocalFolderUser } from './store';

jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'user' } }) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('./reader', () => ({ createFolderReader: jest.fn() }));
const createReader = jest.mocked(createFolderReader);
const dispose = jest.fn();
const execute = jest.fn();
function Picker() {
  const picker = useFolderPicker('chat');
  return (
    <>
      {picker.input}
      <button onClick={() => void picker.connect()}>{'Connect'}</button>
      <span>{picker.message}</span>
      <LocalFolderBadges conversationId="chat" />
    </>
  );
}
const browser = window as Window & { showDirectoryPicker?: jest.Mock };
beforeEach(() => {
  clearLocalFolders();
  setLocalFolderUser('user');
  createReader.mockReturnValue({ dispose, execute });
});
afterEach(() => {
  delete browser.showDirectoryPicker;
  setLocalFolderUser(null);
});

it('requests read permission in the click handler and displays a removable grant', async () => {
  browser.showDirectoryPicker = jest.fn().mockResolvedValue({ name: 'Reports', kind: 'directory' });
  render(<Picker />);
  fireEvent.click(screen.getByText('Connect'));
  expect(browser.showDirectoryPicker).toHaveBeenCalledWith({ mode: 'read' });
  await screen.findByText('Reports');
  expect(execute).not.toHaveBeenCalled();
  expect(createReader).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Reports',
      handle: expect.objectContaining({ name: 'Reports' }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_local_folders_disconnect: Reports' }));
  expect(getLocalFolders('user', 'chat')).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('uses directory file selection as a fallback without reading or uploading', () => {
  render(<Picker />);
  fireEvent.click(screen.getByText('Connect'));
  const input = screen.getByLabelText('com_ui_local_folders_connect');
  expect(input).toHaveAttribute('webkitdirectory');
  const file = new File(['private contents'], 'note.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: 'Notes/note.txt' });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByText('Notes')).toBeInTheDocument();
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
  render(<Picker />);
  fireEvent.click(screen.getByText('Connect'));
  act(() => setLocalFolderUser(null));
  await act(async () => resolve({ name: 'Late folder' }));
  await waitFor(() => expect(dispose).toHaveBeenCalled());
  expect(getLocalFolders('user', 'chat')).toEqual([]);
});

it('refuses an oversized fallback FileList before iterating or copying it', () => {
  render(<Picker />);
  fireEvent.click(screen.getByText('Connect'));
  const files = {
    length: 20001,
    [Symbol.iterator]: () => {
      throw new Error('Must not enumerate the oversized FileList');
    },
  };
  fireEvent.change(screen.getByLabelText('com_ui_local_folders_connect'), { target: { files } });
  expect(screen.getByText('com_ui_local_folders_fallback_limit')).toBeInTheDocument();
  expect(createReader).not.toHaveBeenCalled();
});
