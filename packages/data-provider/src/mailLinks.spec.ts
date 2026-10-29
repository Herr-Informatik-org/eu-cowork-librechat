import { mailPreviewLink, normalizeMailTrustedOrigins } from './mailLinks';

const target =
  'https://erp.rzcloud.ch/mail/view?model=sale.order&res_id=401&access_token=example#inbox';
const wrapped = (value: string) =>
  `https://che01.safelinks.protection.outlook.com/?url=${encodeURIComponent(value)}&data=opaque&sdata=opaque&reserved=0`;

describe('mail preview ERP link boundary', () => {
  test.each([
    target,
    'https://erp.rzcloud.ch',
    'https://erp.rzcloud.ch/odoo/action-778/22/tasks',
    'https://erp.rzcloud.ch/my/subscriptions/401?access_token=example',
    'https://ERP.RZCLOUD.CH/web#id=401&model=sale.order',
  ])('preserves a direct ERP URL byte-for-byte: %s', (href) => {
    expect(mailPreviewLink(href)).toEqual({
      href,
      destination: href,
      viaSafeLinks: false,
      viaOdooRedirect: false,
    });
  });
  test('preserves an existing Microsoft Safe Links wrapper rather than synthesizing a scan', () => {
    const href = wrapped(target);
    expect(mailPreviewLink(href)).toEqual({
      href,
      destination: target,
      viaSafeLinks: true,
      viaOdooRedirect: false,
    });
  });
  test.each([
    'http://erp.rzcloud.ch/a',
    '//erp.rzcloud.ch/a',
    '/mail/view?res_id=1',
    'javascript:alert(1)',
    'data:text/html,anything',
    'https://erp.odoo.ch/a',
    'https://erp.rzcloud.ch.evil.test/a',
    'https://evil.erp.rzcloud.ch/a',
    'https://erp.rzcloud.ch./a',
    'https://erp.rzcloud.ch:443/a',
    'https://erp.rzcloud.ch:8443/a',
    'https://erp.rzcloud.ch@evil.test/a',
    'https://person@erp.rzcloud.ch/a',
    'https://erp%2erzcloud.ch/a',
    'https://erp.rzcloud.ch\\@evil.test/a',
    'https://erp.rzcloud.ch/%5cevil',
    ' https://erp.rzcloud.ch/a',
    'https://erp.rzcloud.ch/a\n',
    'https://erp.rzcloud.ch/%0a',
    'https://erp.rzcloud.ch/%ZZ',
    'https://erp.rzcloud.ch/\u202eevil',
    'https://erp.rzcloud.ch/r',
    'https://erp.rzcloud.ch/r/any-code',
    'https://erp.rzcloud.ch/%72%2fany-code',
    'https://erp.rzcloud.ch/%2572%252fany-code',
    'https://erp.rzcloud.ch/a/%2e%2e/r/any-code',
    'https://erp.rzcloud.ch//r/any-code',
    'https://erp.rzcloud.ch/web/login?redirect=https%3A%2F%2Fevil.test',
    'https://erp.rzcloud.ch/odoo?redirect=%2Fr%2Fevil',
    'https://erp.rzcloud.ch/web?redirect_hostname=evil.test',
    'https://erp.rzcloud.ch/web?Redirect_Url=evil',
    'https://erp.rzcloud.ch/' + 'x'.repeat(16_384),
    wrapped('https://evil.test/'),
    wrapped(wrapped(target)),
    wrapped(encodeURIComponent(target)),
    wrapped(target) + '&url=https%3A%2F%2Fevil.test',
    wrapped(target) + '&URL=' + encodeURIComponent(target),
    wrapped(target) + '&%75rl=' + encodeURIComponent(target),
    wrapped(target) + '&data=second',
    wrapped(target) + '#url=' + encodeURIComponent(target),
    wrapped(target).replace('che01.', ''),
    wrapped(target).replace('che01.', 'evil.che01.'),
    wrapped(target).replace('outlook.com/', 'outlook.com.evil.test/'),
    wrapped(target).replace('outlook.com/', 'outlook.com:443/'),
    wrapped(target).replace('com/?', 'com/other?'),
    wrapped(target).replace('?url=', '?URL='),
  ])('rejects ambiguous, external or known redirect navigation case %#', (href) => {
    expect(mailPreviewLink(href)).toBeUndefined();
  });
});

const mobileWrapped = (value: string) =>
  `https://redirect-url.email/?link=${encodeURIComponent(value)}&apn=com.odoo.mobile&afl=${encodeURIComponent(value)}&ibi=com.odoo.mobile&ifl=${encodeURIComponent(value)}`;

describe('known Odoo wrapper and administrator target policy', () => {
  test.each([false, true])(
    'retains the original wrapper and exposes the inspected target: %s',
    (safeLinks) => {
      const destination = 'https://erp.rzcloud.ch/mail/view?model=account.move&res_id=42';
      const mobile = mobileWrapped(destination);
      const href = safeLinks ? wrapped(mobile) : mobile;
      expect(mailPreviewLink(href)).toEqual({
        href,
        destination,
        viaSafeLinks: safeLinks,
        viaOdooRedirect: true,
      });
    },
  );

  test('accepts the direct record route and exact additional administrator origins only', () => {
    const destination = 'https://portal.customer.example/odoo/account.move/42';
    const origins = ['https://PORTAL.customer.example/'];
    expect(mailPreviewLink(destination)).toBeUndefined();
    expect(mailPreviewLink(wrapped(mobileWrapped(destination)), origins)).toMatchObject({
      destination,
    });
    expect(mailPreviewLink('https://erp.rzcloud.ch/odoo/account.move/42', origins)).toBeUndefined();
    expect(mailPreviewLink('https://erp.rzcloud.ch/odoo/account.move/42')).toBeDefined();
    expect(mailPreviewLink(destination, [])).toBeUndefined();
    expect(normalizeMailTrustedOrigins([...origins, 'https://portal.customer.example'])).toEqual([
      'https://portal.customer.example',
    ]);
  });

  test.each([
    'http://portal.customer.example',
    'https://*.customer.example',
    'https://customer.example/path',
    'https://customer.example?x=1',
    'https://customer.example#x',
    'https://customer.example:443',
    'https://customer.example.',
    'https://127.0.0.1',
    'https://2130706433',
    'https://localhost',
    'https://host.local',
    'https://host.internal',
    'https://redirect-url.email',
    'https://che01.safelinks.protection.outlook.com',
    'https://user@customer.example',
    ' https://customer.example',
    'https://customer.example\\',
    'https://a..customer.example',
    'https://-bad.customer.example',
    'https://customer.example/%2e',
  ])('rejects invalid policy origins without reverting to the default: %s', (origin) => {
    expect(normalizeMailTrustedOrigins([origin])).toBeUndefined();
    expect(mailPreviewLink(target, [origin])).toBeUndefined();
  });

  test('rejects excessive policy size', () => {
    expect(normalizeMailTrustedOrigins(Array(33).fill('https://customer.example'))).toBeUndefined();
  });

  test.each([
    mobileWrapped('https://evil.test/'),
    mobileWrapped('https://erp.rzcloud.ch/r/code'),
    mobileWrapped('https://erp.rzcloud.ch/web/login?redirect=https%3A%2F%2Fevil.test'),
    mobileWrapped('https://erp.rzcloud.ch:443/'),
    mobileWrapped(target).replace('&afl=', '&afl=https%3A%2F%2Fevil.test&other='),
    mobileWrapped(target).replace('&ifl=', '&ifl=https%3A%2F%2Fevil.test&other='),
    mobileWrapped(target).replace('com.odoo.mobile', 'evil.app'),
    mobileWrapped(target).replace('&ibi=com.odoo.mobile', '&ibi=evil.app'),
    mobileWrapped(target).replace('redirect-url.email', 'redirect-url.email.evil.test'),
    mobileWrapped(target).replace('redirect-url.email/', 'redirect-url.email:443/'),
    mobileWrapped(target).replace('redirect-url.email/', 'redirect-url.email/other'),
    mobileWrapped(target).replace('link=', '%6cink='),
    mobileWrapped(target).replace('link=', 'LINK='),
    mobileWrapped(target).replace('&afl=', '&AFL='),
    mobileWrapped(target).replace('&ibi=com.odoo.mobile', ''),
    mobileWrapped(target) + '&link=' + encodeURIComponent(target),
    mobileWrapped(target) + '&redirect=https%3A%2F%2Fevil.test',
    mobileWrapped(target) + '#x',
    mobileWrapped(mobileWrapped(target)),
    mobileWrapped(wrapped(target)),
    mobileWrapped(encodeURIComponent(target)),
    mobileWrapped(target).replace(encodeURIComponent(target), encodeURIComponent(target + '%0a')),
  ])('rejects hostile or ambiguous mobile wrappers directly and within Safe Links: %#', (href) => {
    expect(mailPreviewLink(href)).toBeUndefined();
    expect(mailPreviewLink(wrapped(href))).toBeUndefined();
  });

  test('does not accept different legitimate targets across mobile fallbacks', () => {
    const href = mobileWrapped(target).replace(
      '&afl=' + encodeURIComponent(target),
      '&afl=' + encodeURIComponent('https://erp.rzcloud.ch/odoo/account.move/12'),
    );
    expect(mailPreviewLink(href)).toBeUndefined();
    expect(mailPreviewLink(wrapped(href))).toBeUndefined();
  });
});
