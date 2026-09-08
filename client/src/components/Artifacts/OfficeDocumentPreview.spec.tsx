import { render, screen, waitFor } from '@testing-library/react';
import { request } from 'librechat-data-provider';
import OfficeDocumentPreview, {
  hasOfficePdfReference,
  simplifiedOfficeDocument,
} from './OfficeDocumentPreview';

jest.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => '/assets/pdf.worker.mjs', {
  virtual: true,
});
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({
  request: { get: jest.fn() },
  apiBaseUrl: () => '/workspace',
}));
jest.mock('@librechat/client', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span />,
}));

describe('Office document preview', () => {
  const reference = `<meta name="librechat-office-pdf" content="${'a'.repeat(64)}:xlsx">`;
  beforeAll(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  it('accepts only the bounded, known Office reference contract', () => {
    expect(hasOfficePdfReference(reference)).toBe(true);
    expect(hasOfficePdfReference(reference.replace(':xlsx', ':html'))).toBe(false);
    expect(hasOfficePdfReference(reference.replace('a'.repeat(64), '../../etc/passwd'))).toBe(
      false,
    );
  });
  it('makes legacy CDN fallback readable while denying scripts, forms and network access', () => {
    const html = simplifiedOfficeDocument(
      '<html><head><script src="https://example.org/render.js"></script></head><body><div id="loading">Loading</div><div id="lc-fallback" hidden><table><tr><td>538.92</td></tr></table></div></body></html>',
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('#loading')).toBeNull();
    expect(document.querySelector('#lc-fallback')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain(
      "default-src 'none'",
    );
    expect(document.body.textContent).toContain('538.92');
  });
  it('labels simplified previews and preserves the original download contract', () => {
    const artifact = {
      id: 'test',
      lastUpdateTime: 1,
      content: '<p>Document contents</p>',
      download: { file_id: 'original' },
    };
    render(<OfficeDocumentPreview artifact={artifact} />);
    expect(screen.getByText('com_ui_office_simplified')).toBeInTheDocument();
    expect(screen.getByTitle('com_ui_office_simplified')).toHaveAttribute('sandbox', '');
    expect(artifact.download.file_id).toBe('original');
  });
  it('loads only the authenticated file route and reports failures without external rendering', async () => {
    (request.get as jest.Mock).mockRejectedValue(new Error('unavailable'));
    render(
      <OfficeDocumentPreview
        artifact={{
          id: 'test',
          lastUpdateTime: 1,
          content: reference,
          download: { file_id: 'file-id' },
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText('com_ui_office_unavailable')).toBeInTheDocument());
    expect(request.get).toHaveBeenCalledWith(
      '/workspace/api/files/file-id/preview/pdf',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
    expect(screen.getByRole('button', { name: 'com_ui_refresh' })).toBeInTheDocument();
  });
});
