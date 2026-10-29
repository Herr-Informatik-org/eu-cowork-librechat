import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataService } from 'librechat-data-provider';
import type {
  MailAttachments as AttachmentList,
  MailWorkspaceResult,
} from 'librechat-data-provider';
import {
  isDownloadableMailAttachment,
  mailAttachmentFilename,
  readScannedMailAttachment,
} from '~/data-provider/Mail/attachments';
import mockTranslations from '~/locales/en/translation.json';
import { MailAttachments } from '../Attachments';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key] || key,
}));
jest.mock('~/data-provider/Mail', () => ({
  useMailAttachments: () => ({ data: mockMetadata }),
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { downloadMailWorkspaceAttachment: jest.fn() },
}));
const download = jest.mocked(dataService.downloadMailWorkspaceAttachment);
const file = {
  id: 'pdf',
  name: 'Rechnung.pdf',
  contentType: 'application/pdf',
  size: 4,
  isInline: false,
};
let mockMetadata: AttachmentList;
const result = { id: 'mail-a', revision: 'v1' } as MailWorkspaceResult;
const scannedAt = '2026-10-29T09:00:00.000Z';
function response(
  options: {
    status?: number;
    headers?: Record<string, string | undefined>;
    chunks?: number[];
  } = {},
) {
  const headers: Record<string, string | undefined> = {
    'X-Mail-Attachment-Scan': 'no_known_threats',
    'X-Mail-Attachment-Scanned-At': scannedAt,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="Rechnung.pdf"',
    'Content-Length': '4',
    ...options.headers,
  };
  const chunks = [...(options.chunks || [4])];
  const reader = {
    read: jest.fn(async () =>
      chunks.length ? { done: false, value: new Uint8Array(chunks.shift()!) } : { done: true },
    ),
    cancel: jest.fn(async () => undefined),
    releaseLock: jest.fn(),
  };
  const body = { cancel: jest.fn(async () => undefined), getReader: jest.fn(() => reader) };
  return {
    value: {
      ok: !options.status || options.status === 200,
      status: options.status || 200,
      headers: { get: (name: string) => headers[name] ?? null },
      body,
    } as unknown as Response,
    reader,
    body,
  };
}
function mount() {
  const view = render(<MailAttachments result={result} />);
  const details = view.container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return view;
}
beforeEach(() => {
  mockMetadata = { downloadAvailable: true, attachments: [file], hasMore: false };
  download.mockReset();
  Object.defineProperty(URL, 'createObjectURL', {
    value: jest.fn(() => 'blob:checked-file'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: jest.fn(), configurable: true });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

test('downloads only after explicit action, keeps focus, latches repeated clicks and cleans up object URLs', async () => {
  let resolve!: (response: Response) => void;
  download.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = mount();
  expect(download).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: 'Prüfen und herunterladen' });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(download).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledWith(
    result.id,
    file.id,
    result.revision,
    expect.any(AbortSignal),
  );
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(document.activeElement).toBe(button);
  await act(async () => resolve(response().value));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('iframe,img,object,a')).toBeNull();
  expect(document.querySelector('a[download]')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Keine bekannte Bedrohung erkannt; Download angefordert',
  );
  expect(document.activeElement).toBe(button);
  expect(URL.createObjectURL).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'application/octet-stream', size: 4 }),
  );
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:checked-file');
});

test.each([422, 503, 429, 413, 409])(
  'failed scan/download (%i) never offers a file and allows a deliberate retry',
  async (status) => {
    const failed = response({ status });
    download.mockResolvedValue(failed.value);
    mount();
    const button = screen.getByRole('button', { name: 'Prüfen und herunterladen' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveClass('mail-error'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(failed.body.cancel).toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-disabled', 'false');
    fireEvent(window, new Event('focus'));
    expect(download).toHaveBeenCalledTimes(1);
  },
);

test('unsupported and disabled downloads stay keyboard reachable but never fetch bytes', () => {
  mockMetadata = {
    downloadAvailable: false,
    attachments: [{ ...file, name: '<img src=x>.exe', contentType: 'application/octet-stream' }],
    hasMore: false,
  };
  const view = mount();
  const button = screen.getByRole('button', { name: 'Prüfen und herunterladen' });
  button.focus();
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(document.activeElement).toBe(button);
  expect(screen.getByText('<img src=x>.exe')).toBeInTheDocument();
  expect(view.container.querySelector('img')).toBeNull();
  expect(download).not.toHaveBeenCalled();
});

test('different attachments can run independently while unmount aborts and discards late results', async () => {
  mockMetadata.attachments.push({ ...file, id: 'other', name: 'Andere.pdf' });
  const pending: ((response: Response) => void)[] = [];
  download.mockImplementation(() => new Promise((done) => pending.push(done)));
  const view = mount();
  const buttons = screen.getAllByRole('button', { name: 'Prüfen und herunterladen' });
  fireEvent.click(buttons[0]);
  expect(buttons[1]).toHaveAttribute('aria-disabled', 'false');
  fireEvent.click(buttons[1]);
  expect(download).toHaveBeenCalledTimes(2);
  const signals = download.mock.calls.map((call) => call[3]);
  view.unmount();
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  await act(async () => pending.forEach((resolve) => resolve(response().value)));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test.each([
  { headers: { 'X-Mail-Attachment-Scan': undefined } },
  { headers: { 'X-Mail-Attachment-Scan': 'infected' } },
  { headers: { 'X-Mail-Attachment-Scanned-At': 'invalid' } },
  { headers: { 'Content-Type': 'text/html' } },
  { headers: { 'Content-Disposition': 'inline' } },
  { headers: { 'Content-Length': '20971521' } },
])(
  'rejects malformed or missing scan evidence before reading response bytes (%j)',
  async (options) => {
    const checked = response(options);
    await expect(readScannedMailAttachment(checked.value, 4)).rejects.toMatchObject({
      status: 502,
    });
    expect(checked.body.getReader).not.toHaveBeenCalled();
    expect(checked.body.cancel).toHaveBeenCalled();
  },
);

test.each([[3], [3, 2]])(
  'rejects partial or oversized stream chunks %j and releases resources',
  async (...chunks) => {
    const checked = response({ chunks, headers: { 'Content-Length': undefined } });
    await expect(readScannedMailAttachment(checked.value, 4)).rejects.toBeDefined();
    expect(checked.reader.cancel).toHaveBeenCalled();
    expect(checked.reader.releaseLock).toHaveBeenCalled();
  },
);

test('filename sanitization retains the safe extension and removes header, path and bidi tricks', () => {
  expect(mailAttachmentFilename('../../Dokument\r\n\u202E.exe.pdf')).toBe(
    '_.._Dokument___.exe.pdf',
  );
  expect(mailAttachmentFilename('x'.repeat(200) + '.pdf')).toHaveLength(164);
  expect(isDownloadableMailAttachment({ ...file, name: 'test.pdf.exe' })).toBe(false);
  expect(isDownloadableMailAttachment({ ...file, contentType: 'text/html' })).toBe(false);
  expect(isDownloadableMailAttachment({ ...file, size: 20 * 1024 * 1024 + 1 })).toBe(false);
});
