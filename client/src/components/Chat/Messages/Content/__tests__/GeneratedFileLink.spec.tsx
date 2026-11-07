import { createContext, memo, useContext as mockUseContext } from 'react';
import ReactMarkdown from 'react-markdown';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import GeneratedFileLink from '../GeneratedFileLink';
import {
  rehypeGeneratedFileLinks,
  resolveGeneratedFile,
  isRegisteredFileLink,
} from '../generatedFileLinks';

const mockDownload = jest.fn();
const mockDownloadShared = jest.fn();
const mockDownloadCode = jest.fn();
const mockTrigger = jest.fn();
const mockToast = jest.fn();
const mockOptions = jest.fn();
const mockContext = createContext<{ messageId: string; downloadAttachments?: TAttachment[] }>({
  messageId: 'm1',
});
let mockShareId: string | undefined;
let mockUser = { id: 'owner' };
jest.mock('recoil', () => ({ useRecoilValue: () => mockUser }));
jest.mock('~/store', () => ({ __esModule: true, default: { user: 'user' } }));
jest.mock('~/Providers', () => ({
  useMessageContext: () => mockUseContext(mockContext),
  useShareContext: () => ({ shareId: mockShareId }),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockToast }) }));
jest.mock('~/data-provider', () => ({
  useFileDownload: (...args: unknown[]) => {
    mockOptions(...args);
    return { refetch: mockDownload };
  },
  useSharedFileDownload: () => ({ refetch: mockDownloadShared }),
  useCodeOutputDownload: () => ({ refetch: mockDownloadCode }),
}));
jest.mock('~/utils', () => ({
  authenticatedCodeDownloadPath:
    jest.requireActual('~/utils/downloadFile').authenticatedCodeDownloadPath,
  triggerDownload: (...args: unknown[]) => mockTrigger(...args),
}));

const file = (id = 'file1', filename = 'tickets.json') =>
  ({ file_id: id, filename, filepath: `https://files.example.test/${filename}` }) as TAttachment;
const markup = '[JSON herunterladen](sandbox:/mnt/data/tickets.json)';
const MemoMarkdown = memo(({ text }: { text: string }) => (
  <ReactMarkdown
    rehypePlugins={[rehypeGeneratedFileLinks]}
    components={{ 'generated-file-link': GeneratedFileLink } as never}
  >
    {text}
  </ReactMarkdown>
));
function View({
  attachments,
  text = markup,
  messageId = 'm1',
}: {
  attachments?: TAttachment[];
  text?: string;
  messageId?: string;
}) {
  return (
    <mockContext.Provider value={{ messageId, downloadAttachments: attachments }}>
      <MemoMarkdown text={text} />
    </mockContext.Provider>
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  mockDownload.mockResolvedValue({ data: 'blob:download' });
  mockDownloadShared.mockResolvedValue({ data: 'blob:shared' });
  mockDownloadCode.mockResolvedValue({ data: 'blob:code' });
  URL.revokeObjectURL = jest.fn();
  mockShareId = undefined;
  mockUser = { id: 'owner' };
});

test('uses only exact current-message paths and deduplicates the same stored ID', () => {
  expect(resolveGeneratedFile('sandbox:/mnt/data/tickets.json', [file(), file()])).toMatchObject({
    file_id: 'file1',
    filename: 'tickets.json',
  });
  expect(
    resolveGeneratedFile('sandbox:/mnt/data/tickets.json', [file(), file('file2')]),
  ).toBeUndefined();
  expect(
    resolveGeneratedFile('sandbox:/mnt/data/tickets.json', [file('file1', 'other/tickets.json')]),
  ).toBeUndefined();
  expect(
    resolveGeneratedFile('sandbox:/mnt/data/other/tickets.json', [
      file('file1', 'other/tickets.json'),
    ]),
  ).toBeDefined();
  expect(
    resolveGeneratedFile('sandbox:/mnt/data/tickets.json', [
      { filename: 'tickets.json' } as TAttachment,
    ]),
  ).toBeUndefined();
});
test.each([
  'sandbox:/mnt/data/../tickets.json',
  'sandbox:/mnt/data/%2e%2e/tickets.json',
  'sandbox:/mnt/data/tickets.json?x',
  'sandbox:/mnt/data/tickets.json#x',
  'sandbox:/mnt/data/%252e%252e/tickets.json',
  'sandbox:/etc/tickets.json',
])('rejects ambiguous sandbox reference %s', (href) => {
  expect(resolveGeneratedFile(href, [file()])).toBeUndefined();
});
test('recognizes only exact attachment URLs and preserves ambiguity', () => {
  const href = 'https://files.example.test/tickets.json';
  expect(isRegisteredFileLink(href, [file()])).toBe(true);
  expect(isRegisteredFileLink('https://other.example.test/tickets.json', [file()])).toBe(false);
  expect(resolveGeneratedFile(href, [file()])).toMatchObject({
    file_id: 'file1',
    filename: 'tickets.json',
  });
  expect(resolveGeneratedFile(href, [file(), file('other')])).toBeUndefined();
});
test('real markdown rewrites sandbox links into controls without permitting unsafe URL schemes', async () => {
  const { container } = render(
    <View attachments={[file()]} text={`${markup}\n\n[Unsafe](javascript:alert(1))`} />,
  );
  expect(container.querySelector('a[href^="sandbox:"]')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'JSON herunterladen' }));
  await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:download', 'tickets.json'));
  expect(mockOptions).toHaveBeenCalledWith('owner', 'file1', { direct: false, source: undefined });
});
test('late attachments activate an already rendered markdown link through message context', async () => {
  const { rerender } = render(<View />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_generated_file_unavailable');
  expect(mockDownload).not.toHaveBeenCalled();
  rerender(<View attachments={[file()]} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1));
});
test('ambiguous references give visible feedback without downloading either candidate', () => {
  render(<View attachments={[file(), file('other')]} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_generated_file_unavailable');
  expect(mockDownload).not.toHaveBeenCalled();
});
test('errors report a toast and never download stale query data', async () => {
  mockDownload.mockResolvedValue({ isError: true, data: 'blob:stale' });
  render(<View attachments={[file()]} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith({ status: 'error', message: 'com_ui_download_error' }),
  );
  expect(mockTrigger).not.toHaveBeenCalled();
});
test('a late response cannot trigger a download after the message changes', async () => {
  let resolve!: (value: object) => void;
  mockDownload.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { rerender } = render(<View attachments={[file()]} />);
  fireEvent.click(screen.getByRole('button'));
  rerender(<View messageId="other" />);
  await act(async () => resolve({ data: 'blob:old-message' }));
  expect(mockTrigger).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old-message');
});
test('shared views retain the share-scoped download route', async () => {
  mockShareId = 'share1';
  render(
    <View
      attachments={[{ ...file(), filepath: '/api/share/share1/files/file1' } as TAttachment]}
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:shared', 'tickets.json'));
  expect(mockDownload).not.toHaveBeenCalled();
});

test('preserves legacy code metadata and uses only the authenticated code route', async () => {
  const code = {
    ...file(),
    source: 'execute_code',
    filepath: `/api/files/code/download/${'a'.repeat(21)}/${'b'.repeat(21)}`,
  } as TAttachment;
  render(<View attachments={[code]} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith('blob:code', 'tickets.json'));
  expect(mockDownload).not.toHaveBeenCalled();
});
