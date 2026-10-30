import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LogLink from '../LogLink';

const mockShowToast = jest.fn();
const mockDownloadFromApi = jest.fn();
const mockDownloadFromUrl = jest.fn();
const mockDownloadFromShare = jest.fn();
const mockTriggerDownload = jest.fn();
const mockUseFileDownload = jest.fn();
let mockShareContext: { shareId?: string } = {};
let mockUser: { id: string } | null = { id: 'current-user' };
const codePath = '/api/files/code/download/abcdefghijklmnopqrstu/ABCDEFGHIJKLMNOPQRSTU';

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: () => mockUser,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/data-provider', () => ({
  useFileDownload: (...args: Parameters<typeof mockUseFileDownload>) => {
    mockUseFileDownload(...args);
    return { refetch: mockDownloadFromApi };
  },
  useCodeOutputDownload: () => ({ refetch: mockDownloadFromUrl }),
  useSharedFileDownload: () => ({ refetch: mockDownloadFromShare }),
}));
jest.mock('~/Providers', () => ({ useShareContext: () => mockShareContext }));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/downloadFile'),
  triggerDownload: (...args: Parameters<typeof mockTriggerDownload>) =>
    mockTriggerDownload(...args),
}));

describe('LogLink download routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareContext = {};
    mockUser = { id: 'current-user' };
  });

  it.each(['json', 'xml'])(
    'never navigates or sends credentials to an unregistered external %s URL',
    async (ext) => {
      const filename = `report.${ext}`;
      render(
        <LogLink href={`https://cdn.example.com/uploads/${filename}`} filename={filename}>
          {filename}
        </LogLink>,
      );
      const link = screen.getByRole('link', { name: filename });
      expect(link).not.toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('href', '#');
      fireEvent.click(link);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          status: 'error',
          message: 'com_ui_download_error',
        }),
      );
      expect(mockTriggerDownload).not.toHaveBeenCalled();
      expect(mockDownloadFromUrl).not.toHaveBeenCalled();
      expect(mockDownloadFromApi).not.toHaveBeenCalled();
    },
  );

  it.each(['json', 'xml'])(
    'forces the authorized blob route for a stored cloud %s file',
    async (ext) => {
      const filename = `file.${ext}`;
      mockDownloadFromApi.mockResolvedValue({ data: 'blob:original-file' });
      render(
        <LogLink
          user="owner-1"
          file_id="file-1"
          filename={filename}
          source={FileSources.cloudfront}
          href={`https://cdn.example.com/${filename}`}
        >
          {filename}
        </LogLink>,
      );
      fireEvent.click(screen.getByRole('link', { name: filename }));
      await waitFor(() =>
        expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original-file', filename),
      );
      expect(mockUseFileDownload).toHaveBeenCalledWith('owner-1', 'file-1', {
        source: FileSources.cloudfront,
        direct: false,
      });
      expect(mockDownloadFromApi).toHaveBeenCalledTimes(1);
      expect(mockDownloadFromUrl).not.toHaveBeenCalled();
    },
  );

  it('uses the authenticated current user when a registered attachment omits owner and source', async () => {
    mockDownloadFromApi.mockResolvedValue({ data: 'blob:original-json' });
    render(
      <LogLink file_id="file-1" filename="file.json" href="/uploads/owner/file.json">
        {'file.json'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original-json', 'file.json'),
    );
    expect(mockUseFileDownload).toHaveBeenCalledWith('current-user', 'file-1', {
      source: undefined,
      direct: false,
    });
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  it('uses the share-scoped blob route in a shared view', async () => {
    mockShareContext = { shareId: 'share-9' };
    mockDownloadFromShare.mockResolvedValue({ data: 'blob:shared-json' });
    render(
      <LogLink href="/api/share/share-9/files/file-1" file_id="file-1" filename="file.json">
        {'file.json'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:shared-json', 'file.json'),
    );
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  it('keeps valid legacy code-output handles on the authenticated code blob route', async () => {
    mockDownloadFromUrl.mockResolvedValue({ data: 'blob:code-original' });
    render(
      <LogLink
        href={codePath}
        file_id="legacy-file-id"
        filename="legacy.xml"
        source={FileSources.execute_code}
      >
        {'legacy.xml'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:code-original', 'legacy.xml'),
    );
    expect(mockDownloadFromUrl).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
  });

  it.each([
    { data: 'blob:cached-original', isError: true },
    { data: 'https://cdn.example.com/inline.json' },
    { data: undefined },
  ])('reports failed or nonblob responses instead of announcing success', async (response) => {
    mockDownloadFromApi.mockResolvedValue(response);
    render(
      <LogLink file_id="file-1" filename="file.json" href="/uploads/file.json">
        {'file.json'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('reports network failures visibly and keeps the current page', async () => {
    mockDownloadFromApi.mockRejectedValueOnce(new Error('Network unavailable'));
    render(
      <LogLink file_id="file-1" filename="file.xml" href="/uploads/file.xml">
        {'file.xml'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('does not deliver an in-flight private download after logout', async () => {
    let resolve: (result: { data: string }) => void = () => undefined;
    mockDownloadFromApi.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const revoke = jest.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const { rerender } = render(
      <LogLink file_id="file-1" filename="file.json" href="/uploads/file.json">
        {'file.json'}
      </LogLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    mockUser = null;
    rerender(
      <LogLink file_id="file-1" filename="file.json" href="/uploads/file.json">
        {'file.json'}
      </LogLink>,
    );
    resolve({ data: 'blob:private-old-session' });
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:private-old-session'));
    expect(mockTriggerDownload).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});
