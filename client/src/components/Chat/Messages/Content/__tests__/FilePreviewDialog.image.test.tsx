import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import FilePreviewDialog from '../FilePreviewDialog';

const mockFetch = jest.fn();
const mockOwned = jest.fn();
const mockShared = jest.fn();
let mockShareId: string | undefined;
jest.mock('recoil', () => ({
  useRecoilValue: () => ({ id: 'user' }),
  useSetRecoilState: () => jest.fn(),
}));
jest.mock('~/store', () => ({ __esModule: true, default: {} }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: mockShareId }),
}));
jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: mockOwned }),
  useSharedFileDownload: () => ({ refetch: mockShared }),
}));
jest.mock('~/utils', () => ({
  logger: { error: jest.fn() },
  sortPagesByRelevance: jest.fn(),
  triggerDownload: jest.fn(),
}));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);
jest.mock('@librechat/client', () => ({
  OGDialog: ({ children, open }: PropsWithChildren<{ open: boolean }>) =>
    open ? <div role="dialog">{children}</div> : null,
  OGDialogContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  OGDialogTitle: ({ children }: PropsWithChildren) => <h2>{children}</h2>,
  OGDialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
}));

const props = {
  open: true,
  onOpenChange: jest.fn(),
  fileId: 'image',
  fileName: 'clipboard.png',
  fileType: 'image/png',
};

beforeEach(() => {
  mockShareId = undefined;
  mockOwned.mockReset().mockResolvedValue({ data: 'blob:download' });
  mockShared.mockReset().mockResolvedValue({ data: 'blob:shared-download' });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['image'], { type: 'application/octet-stream' }),
  });
  Object.defineProperty(global, 'fetch', { configurable: true, value: mockFetch });
  URL.createObjectURL = jest.fn().mockReturnValue('blob:preview');
  URL.revokeObjectURL = jest.fn();
});

test.each([
  ['clipboard.png', 'image/png'],
  ['photo.JPG', 'application/octet-stream'],
  ['diagram.svg', 'image/svg+xml'],
  ['animation.gif', undefined],
  ['photo.webp', 'image/webp'],
])(
  'previews %s as an image rather than unsupported text or an iframe',
  async (fileName, fileType) => {
    const { container } = render(
      <FilePreviewDialog {...props} fileName={fileName} fileType={fileType} />,
    );
    const image = await screen.findByAltText(fileName);
    expect(image).toHaveAttribute('src', 'blob:preview');
    expect(container.querySelector('iframe')).toBeNull();
    expect(mockOwned).toHaveBeenCalledTimes(1);
    expect(mockShared).not.toHaveBeenCalled();
  },
);

test('shows image dimensions and supports bounded zoom', async () => {
  render(<FilePreviewDialog {...props} />);
  const image = await screen.findByAltText('clipboard.png');
  Object.defineProperties(image, {
    naturalWidth: { value: 1200 },
    naturalHeight: { value: 800 },
  });
  fireEvent.load(image);
  expect(screen.getByText('1200 × 800')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_zoom_in' }));
  expect(screen.getByText('150%')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_zoom_out' }));
  expect(screen.getByText('100%')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_zoom_out' })).toBeDisabled();
});

test('shows an unavailable state when the image cannot be decoded', async () => {
  render(<FilePreviewDialog {...props} />);
  fireEvent.error(await screen.findByAltText('clipboard.png'));
  expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(mockOwned).toHaveBeenCalledTimes(1);
});

test('uses only the authorized snapshot route for shared images', async () => {
  mockShareId = 'share';
  render(<FilePreviewDialog {...props} filePath="/api/share/share/files/image" />);
  await screen.findByAltText('clipboard.png');
  expect(mockShared).toHaveBeenCalledTimes(1);
  expect(mockOwned).not.toHaveBeenCalled();
});

test('does not display cached data after a failed authorization refresh', async () => {
  mockOwned.mockResolvedValue({ data: 'blob:stale', isError: true });
  render(<FilePreviewDialog {...props} />);
  await screen.findByText('com_ui_preview_unavailable');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('cleans up preview URLs on close and loads again on reopening', async () => {
  const { rerender } = render(<FilePreviewDialog {...props} />);
  await screen.findByAltText('clipboard.png');
  rerender(<FilePreviewDialog {...props} open={false} />);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  rerender(<FilePreviewDialog {...props} />);
  await screen.findByAltText('clipboard.png');
  expect(mockOwned).toHaveBeenCalledTimes(2);
});

test('ignores a late download when the selected file changes', async () => {
  let finishFirst!: (result: { data: string }) => void;
  mockOwned.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  const { rerender } = render(<FilePreviewDialog {...props} />);
  rerender(<FilePreviewDialog {...props} fileId="second" fileName="second.png" />);
  await screen.findByAltText('second.png');
  await act(async () => finishFirst({ data: 'blob:first' }));
  expect(global.fetch).not.toHaveBeenCalledWith('blob:first', expect.anything());
  expect(mockOwned).toHaveBeenCalledTimes(2);
});

test('checks HTTP failures before attempting to render response bodies', async () => {
  const readBody = jest.fn();
  mockFetch.mockResolvedValue({ ok: false, blob: readBody });
  render(<FilePreviewDialog {...props} />);
  await waitFor(() => expect(screen.getByText('com_ui_preview_unavailable')).toBeInTheDocument());
  expect(readBody).not.toHaveBeenCalled();
});
