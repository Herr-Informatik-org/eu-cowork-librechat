import { mailPreviewLink } from './mailLinks';

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
    expect(mailPreviewLink(href)).toEqual({ href, viaSafeLinks: false });
  });
  test('preserves an existing Microsoft Safe Links wrapper rather than synthesizing a scan', () => {
    const href = wrapped(target);
    expect(mailPreviewLink(href)).toEqual({ href, viaSafeLinks: true });
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
