import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import type { MailWorkspacePreview } from 'librechat-data-provider';
import MailImages from '../Images';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider/Mail', () => jest.requireActual('~/data-provider/Mail/images'));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { loadMailWorkspaceImages: jest.fn() },
}));
const load = jest.mocked(dataService.loadMailWorkspaceImages);
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kAAAAABJRU5ErkJggg==';
const preview: MailWorkspacePreview = {
  html: '<p>Mail A</p><img alt="Logo">',
  embeddedImagesAvailable: true,
  blockedImages: 1,
  truncated: false,
  warnings: [],
};
const loaded: MailWorkspacePreview = {
  ...preview,
  html: `<p>Mail A</p><img src="${png}"><img src="https://tracker.test/pixel" onload="alert(1)"><svg onload="alert(2)">bad</svg>`,
  imagesLoaded: true,
  blockedImages: 0,
};
function mount() {
  const client = new QueryClient({ logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } });
  const content = (id = 'result-a', kind: 'original' | 'draft' = 'original', revision = 'v1') => (
    <QueryClientProvider client={client}>
      <MailImages
        id={id}
        revision={revision}
        kind={kind}
        title="Mail"
        text="Fallback"
        preview={preview}
      />
    </QueryClientProvider>
  );
  return { client, content, ...render(content()) };
}
const frame = () => screen.getByTitle('Mail').getAttribute('srcdoc') || '';
beforeEach(() => load.mockReset());
afterEach(() => onlineManager.setOnline(true));

test('loads only on explicit click, renders only passive raster images and never caches response bytes', async () => {
  load.mockResolvedValue(loaded);
  const view = mount();
  expect(load).not.toHaveBeenCalled();
  expect(frame()).not.toContain('data:image');
  fireEvent(window, new Event('focus'));
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_images_load' }));
  await waitFor(() => expect(frame()).toContain(png));
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith('result-a', { kind: 'original', revision: 'v1' });
  const doc = new DOMParser().parseFromString(frame(), 'text/html');
  expect(doc.body.querySelectorAll('img[src]')).toHaveLength(1);
  expect(doc.body.querySelector('svg,script,[onload],[srcset]')).toBeNull();
  expect(doc.body.innerHTML).not.toContain('tracker.test');
  expect(screen.getByTitle('Mail')).toHaveAttribute('sandbox', '');
  expect(view.client.getQueryCache().getAll()).toHaveLength(0);
  expect(
    view.client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
  ).toEqual([undefined]);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_images_hide' }));
  expect(frame()).not.toContain(png);
  expect(load).toHaveBeenCalledTimes(1);
});

test.each(['mail', 'kind', 'revision'] as const)(
  'discards loaded images and stale in-flight results on %s changes',
  async (change) => {
    let resolve!: (value: MailWorkspacePreview) => void;
    load.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_images_load' }));
    expect(
      await screen.findByRole('button', { name: 'com_ui_mail_images_loading' }),
    ).toBeDisabled();
    view.rerender(
      view.content(
        change === 'mail' ? 'result-b' : 'result-a',
        change === 'kind' ? 'draft' : 'original',
        change === 'revision' ? 'v2' : 'v1',
      ),
    );
    await act(async () => resolve(loaded));
    expect(frame()).not.toContain(png);
    expect(screen.getByRole('button', { name: 'com_ui_mail_images_load' })).toBeEnabled();
    expect(load).toHaveBeenCalledTimes(1);
  },
);

test('a loaded preview is discarded when switching away and returning, and repeated clicks enqueue one request', async () => {
  load.mockResolvedValue(loaded);
  const view = mount();
  const button = screen.getByRole('button', { name: 'com_ui_mail_images_load' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(frame()).toContain(png));
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(view.content('result-b'));
  expect(frame()).not.toContain(png);
  view.rerender(view.content());
  expect(frame()).not.toContain(png);
  expect(load).toHaveBeenCalledTimes(1);
});

test('does not automatically retry errors or refetch when the window regains focus', async () => {
  load.mockRejectedValue(new Error('private raw backend error'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_images_load' }));
  await screen.findByRole('alert');
  fireEvent(window, new Event('focus'));
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent('com_ui_mail_images_error');
  expect(screen.getByRole('alert')).not.toHaveTextContent('private raw');
  expect(frame()).not.toContain(png);
});

test('does not defer an offline image request to a later reconnect', async () => {
  onlineManager.setOnline(false);
  load.mockRejectedValue(new Error('offline'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_images_load' }));
  await screen.findByRole('alert');
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => onlineManager.setOnline(true));
  expect(load).toHaveBeenCalledTimes(1);
});

test('has no image action for mails without embedded images and refuses data images without the explicit loaded flag', () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MailImages
        id="external"
        revision="v1"
        kind="original"
        title="Mail"
        text="Fallback"
        preview={{
          ...preview,
          embeddedImagesAvailable: false,
          html: `<img src="${png}"><img src="https://tracker.test">`,
        }}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  const doc = new DOMParser().parseFromString(frame(), 'text/html');
  expect(doc.body.querySelector('img[src]')).toBeNull();
  expect(load).not.toHaveBeenCalled();
});
