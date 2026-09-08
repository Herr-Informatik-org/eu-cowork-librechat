import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import { FileSources } from 'librechat-data-provider';
import { useFileDownload } from '~/data-provider';
import { triggerDownload } from '~/utils';
import SessionFileDownloadButton from './SessionFileDownloadButton';

const mockApiDownload = jest.fn();
const mockUrlDownload = jest.fn();
const mockToast = jest.fn();

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockToast }) }));
jest.mock('~/Providers', () => ({ useShareContext: () => ({}) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useFileDownload: jest.fn(() => ({ refetch: mockApiDownload })),
  useCodeOutputDownload: () => ({ refetch: mockUrlDownload }),
}));
jest.mock('~/utils', () => ({
  isHttpDownloadTarget: (href: string) => /^https?:/.test(href),
  triggerDownload: jest.fn(),
}));

const file: Partial<TFile> = {
  file_id: 'file-one',
  user: 'owner-one',
  source: FileSources.local,
  filename: 'result.xlsx',
  filepath: '/uploads/owner-one/file-one__result.xlsx',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockApiDownload.mockResolvedValue({ data: 'blob:original-file' });
});

test('a local original uses the authenticated file route instead of navigating to uploads', async () => {
  const { container } = render(<SessionFileDownloadButton file={file} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(triggerDownload).toHaveBeenCalledWith('blob:original-file', 'result.xlsx'),
  );
  expect(useFileDownload).toHaveBeenCalledWith('owner-one', 'file-one', { source: 'local' });
  expect(mockApiDownload).toHaveBeenCalledTimes(1);
  expect(mockUrlDownload).not.toHaveBeenCalled();
  expect(container.querySelector('a[href^="/uploads/"]')).toBeNull();
});

test('complete local metadata permits downloading even without a public filepath', async () => {
  render(<SessionFileDownloadButton file={{ ...file, filepath: undefined }} />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(triggerDownload).toHaveBeenCalledWith('blob:original-file', 'result.xlsx'),
  );
  expect(mockApiDownload).toHaveBeenCalledTimes(1);
});

test('code output keeps its existing download route', async () => {
  mockUrlDownload.mockResolvedValueOnce({ data: 'blob:code-result' });
  render(
    <SessionFileDownloadButton
      file={{
        ...file,
        source: FileSources.execute_code,
        filepath: '/api/files/code/output/file-one',
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() =>
    expect(triggerDownload).toHaveBeenCalledWith('blob:code-result', 'result.xlsx'),
  );
  expect(mockUrlDownload).toHaveBeenCalledTimes(1);
  expect(mockApiDownload).not.toHaveBeenCalled();
});

test('a bare reference or unsafe URL does not create a download action', () => {
  const { rerender } = render(<SessionFileDownloadButton file={{ file_id: 'reference-only' }} />);
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<SessionFileDownloadButton file={{ filepath: 'javascript:alert(1)' }} />);
  expect(screen.queryByRole('button')).toBeNull();
});
