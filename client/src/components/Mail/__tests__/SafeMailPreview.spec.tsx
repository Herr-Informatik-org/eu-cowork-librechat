import { render, screen } from '@testing-library/react';
import SafeMailPreview, { createMailPreviewDocument } from '../SafeMailPreview';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const parse = (value: string) => new DOMParser().parseFromString(value, 'text/html');

describe('opaque mail preview frame', () => {
  test('preserves formatting while scripts, forms, links, namespaces and network attributes disappear', () => {
    const output = createMailPreviewDocument(
      '<script>alert(1)</script><style>@import "https://tracker.test";</style><svg onload="alert(1)"><foreignObject>bad</foreignObject></svg><math><mi>x</mi></math><form action="https://tracker.test"><input name="password"></form><p onclick="alert(1)" style="color:#123456;font-weight:bold">Hallo</p><table><tr><td colspan="2">Inhalt</td></tr></table><a href="https://tracker.test" target="_top">Link</a><meta http-equiv="refresh" content="0;https://tracker.test"><base href="https://tracker.test">',
    );
    expect(output).toBeDefined();
    const doc = parse(output!);
    expect(doc.body.querySelectorAll('script,style,svg,math,form,input,a,meta,base')).toHaveLength(
      0,
    );
    expect(doc.body.querySelector('[onclick],[href],[action]')).toBeNull();
    expect(doc.body.querySelector('p')?.getAttribute('style')).toContain('font-weight:bold');
    expect(doc.body.querySelector('td')?.getAttribute('colspan')).toBe('2');
  });
  test('independently strips CSS fetches, fixed overlays and browser extensions', () => {
    const output = createMailPreviewDocument(
      '<div style="background:url(https://tracker.test);position:fixed;top:0;left:0;z-index:999;behavior:url(x);color:red">Mail</div><p style="background:u\\72l(https://tracker.test);font-family:var(--secret)">X</p>',
    );
    const doc = parse(output!);
    expect(doc.body.innerHTML).not.toMatch(/tracker|url|position|z-index|behavior|var\(/);
    expect(doc.body.textContent).toBe('MailX');
  });
  test('blocks attacker data SVG, HTML, remote and relative image sources', () => {
    const output = createMailPreviewDocument(
      '<img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:text/html;base64,PHNjcmlwdD4="><img src="https://tracker.test/pixel"><img src="/api/me"><img srcset="https://tracker.test/pixel 2x">',
    );
    const doc = parse(output!);
    expect(doc.body.querySelector('[src],[srcset]')).toBeNull();
    expect(doc.body.querySelectorAll('img')).toHaveLength(5);
  });
  test('CSP denies network and execution before any message markup', () => {
    const output = createMailPreviewDocument('<p>Mail</p>')!;
    const doc = parse(output);
    const csp = doc.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    for (const expected of [
      "default-src 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      'img-src data:',
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ])
      expect(csp).toContain(expected);
    expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf('<body>'));
  });
  test('accepts only a bounded count of server-reencoded PNG sources', () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kAAAAABJRU5ErkJggg==';
    const output = createMailPreviewDocument(`<img src="${png}" alt="Logo">`.repeat(12))!;
    const doc = parse(output);
    expect(doc.body.querySelectorAll('img[src]')).toHaveLength(8);
    expect(doc.body.querySelector('img')?.getAttribute('src')).toBe(png);
    expect(doc.body.querySelectorAll('img:not([src])')).toHaveLength(4);
  });
  test('renders into a sandbox with no privileges and never into parent HTML', () => {
    render(
      <SafeMailPreview
        title="Originalmail"
        text="Fallback"
        preview={{
          html: '<p>Mail body</p>',
          blockedImages: 1,
          truncated: true,
          warnings: ['Sicherer Hinweis'],
        }}
      />,
    );
    const frame = screen.getByTitle('Originalmail');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).not.toHaveAttribute('src');
    expect(screen.queryByText('Mail body')).not.toBeInTheDocument();
    expect(screen.getByText('Sicherer Hinweis')).toBeInTheDocument();
  });
  test('large and pathological preview falls back to escaped text', () => {
    expect(createMailPreviewDocument('x'.repeat(4_000_001))).toBeUndefined();
    expect(createMailPreviewDocument('<p>x</p>'.repeat(20_001))).toBeUndefined();
    render(<SafeMailPreview title="Mail" text={'<img src="https://tracker.test">'} />);
    expect(screen.getByText('<img src="https://tracker.test">').tagName).toBe('PRE');
    expect(document.querySelector('img')).toBeNull();
  });
  test('a changed preview replaces the srcdoc without retaining the previous mailbox', () => {
    const { rerender } = render(
      <SafeMailPreview
        title="Mail"
        text="A"
        preview={{ html: '<p>Mailbox A</p>', blockedImages: 0, truncated: false, warnings: [] }}
      />,
    );
    rerender(
      <SafeMailPreview
        title="Mail"
        text="B"
        preview={{ html: '<p>Mailbox B</p>', blockedImages: 0, truncated: false, warnings: [] }}
      />,
    );
    expect(screen.getByTitle('Mail').getAttribute('srcdoc')).toContain('Mailbox B');
    expect(screen.getByTitle('Mail').getAttribute('srcdoc')).not.toContain('Mailbox A');
  });
});
