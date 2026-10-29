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
    const output = createMailPreviewDocument(
      `<img src="${png}" alt="Logo">`.repeat(12),
      false,
      true,
    )!;
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
  test('revalidates ERP links and replaces all navigation privileges with fixed new-tab attributes', () => {
    const wrapped =
      'https://che01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ferp.rzcloud.ch%2Fmail%2Fview%3Fres_id%3D4&reserved=0';
    const output = createMailPreviewDocument(
      `<a href="https://erp.rzcloud.ch/odoo" target="_top" rel="opener" ping="https://tracker.test" download onclick="alert(1)">ERP</a><a href="${wrapped}">Safe Links</a><a href="https://evil.test">Blocked</a><a href="https://erp.rzcloud.ch/r/code">Redirect</a><a href="javascript:alert(1)">Script</a>`,
      true,
    );
    const doc = parse(output!);
    const anchors = doc.body.querySelectorAll('a[href]');
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
      expect(anchor.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(anchor.getAttribute('title')).toContain('erp.rzcloud.ch');
    }
    expect(anchors[1].getAttribute('href')).toBe(wrapped);
    expect(doc.body.innerHTML).not.toMatch(
      /_top|ping=|download|onclick|evil.test|tracker|javascript:|\/r\/code/,
    );
    expect(doc.body.textContent).toContain('BlockedRedirectScript');
  });
  test('deployment opt-in grants only user-clicked popup navigation with no preview execution or fetches', () => {
    render(
      <SafeMailPreview
        title="ERP Mail"
        text="Fallback"
        preview={{
          html: '<a href="https://erp.rzcloud.ch/odoo">ERP</a><img src="https://erp.rzcloud.ch/pixel"><script>alert(1)</script><form action="https://erp.rzcloud.ch"><input name="x"></form>',
          blockedImages: 1,
          truncated: false,
          warnings: [],
          linksEnabled: true,
        }}
      />,
    );
    const frame = screen.getByTitle('ERP Mail');
    expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const doc = parse(frame.getAttribute('srcdoc')!);
    expect(doc.body.querySelector('a')?.getAttribute('href')).toBe('https://erp.rzcloud.ch/odoo');
    expect(doc.body.querySelector('script,form,input,[src],[onclick]')).toBeNull();
    expect(screen.getByText('com_ui_mail_preview_allowed_links')).toBeInTheDocument();
  });
  test('mail-supplied attributes cannot enable links without the separate server flag', () => {
    const doc = parse(
      createMailPreviewDocument(
        '<a href="https://erp.rzcloud.ch/odoo" data-links-enabled="true">ERP</a>',
      )!,
    );
    expect(doc.body.querySelector('a,[href],[data-links-enabled]')).toBeNull();
    expect(doc.body.textContent).toBe('ERP');
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

test('enforces exact per-instance origins and explicit deny-all without restoring stripped links', () => {
  const input =
    '<a href="https://erp.customer.example/task/1">Customer</a><a href="https://erp.rzcloud.ch/odoo">Internal</a><a data-href="https://erp.customer.example/task/2" title="https://erp.customer.example/task/2">Blocked by server</a>';
  const custom = parse(
    createMailPreviewDocument(input, true, false, ['https://erp.customer.example'])!,
  );
  expect(custom.body.querySelectorAll('a[href]')).toHaveLength(1);
  expect(custom.body.querySelector('a[href]')?.getAttribute('title')).toBe('erp.customer.example');
  expect(custom.body.querySelectorAll('a')[2].hasAttribute('href')).toBe(false);
  const denied = parse(createMailPreviewDocument(input, true, false, [])!);
  expect(denied.body.querySelector('a[href]')).toBeNull();
});

test.each(['unavailable', 'disabled'] as const)(
  'suppresses navigation for %s checks even with a contradictory enabled flag',
  (status) => {
    render(
      <SafeMailPreview
        title="Mail"
        text="Fallback"
        preview={{
          html: '<a href="https://erp.rzcloud.ch/odoo">ERP</a>',
          blockedImages: 0,
          warnings: [],
          truncated: false,
          linksEnabled: true,
          trustedOrigins: ['https://erp.rzcloud.ch'],
          linkCheck: { status, blocked: 0 },
        }}
      />,
    );
    const frame = screen.getByTitle('Mail');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(parse(frame.getAttribute('srcdoc')!).body.querySelector('[href]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(`com_ui_mail_links_${status}`);
  },
);

test('known threat status shows the snapshot time and keeps only hrefs the server retained', () => {
  render(
    <SafeMailPreview
      title="Mail"
      text="Fallback"
      preview={{
        html: '<a>Flagged by server</a><a href="https://erp.rzcloud.ch/odoo">Allowed</a>',
        blockedImages: 0,
        warnings: [],
        truncated: false,
        linksEnabled: true,
        trustedOrigins: ['https://erp.rzcloud.ch'],
        linkCheck: {
          status: 'known_threat',
          blocked: 1,
          checkedAt: '2026-10-29T09:00:00.000Z',
          sourceUpdatedAt: '2026-10-29T08:00:00.000Z',
        },
      }}
    />,
  );
  const doc = parse(screen.getByTitle('Mail').getAttribute('srcdoc')!);
  expect(doc.body.querySelectorAll('a[href]')).toHaveLength(1);
  expect(doc.body.querySelector('a')?.hasAttribute('href')).toBe(false);
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_mail_links_blocked');
  expect(document.querySelectorAll('time')).toHaveLength(2);
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-29T09:00:00.000Z');
});
