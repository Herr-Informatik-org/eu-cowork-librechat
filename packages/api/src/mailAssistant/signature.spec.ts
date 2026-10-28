import sharp from 'sharp';

const logoMarker = '<span data-kisuno-signature-logo="true">[Signatur-Logo]</span>';
const logoCid = 'kisuno-signature-11111111-2222-3333-4444-555555555555';
import {
  normalizeMailSignature,
  renderMailSignature,
  sanitizeMailSignature,
  sanitizeSignatureHtml,
} from './signature';

const signature = {
  enabled: true,
  html: '<p>Freundliche Grüsse<br><b>Eigener Name</b></p>',
  fontFamily: 'Calibri',
  fontSize: 11,
};

describe('explicit personal mail signature', () => {
  it('re-encodes only explicit small PNG pixels and renders a separate CID reference', async () => {
    const input = await sharp({
      create: { width: 4, height: 2, channels: 4, background: '#123456' },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const safe = await sanitizeMailSignature({
      ...signature,
      logo: { contentBytes: input.toString('base64') },
    });
    const metadata = await sharp(Buffer.from(safe.logo!.contentBytes, 'base64')).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 4, height: 2 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const html = renderMailSignature(safe, 'kisuno-signature-11111111-2222-3333-4444-555555555555');
    expect(html).toContain('src="cid:kisuno-signature-11111111-2222-3333-4444-555555555555"');
    expect(html).toContain('width="4" height="2"');
    expect(html).not.toContain(safe.logo!.contentBytes);
  });
  it('rejects SVG, oversized dimensions, trailers and malformed chunks before accepting logo data', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer();
    const giant = Buffer.from(input);
    giant.writeUInt32BE(100000, 16);
    for (const invalid of [
      Buffer.from('<svg onload="alert(1)"/>'),
      giant,
      Buffer.concat([input, Buffer.from('<script>')]),
      input.subarray(0, 40),
    ]) {
      await expect(
        sanitizeMailSignature({ ...signature, logo: { contentBytes: invalid.toString('base64') } }),
      ).rejects.toThrow();
    }
  });
  it('preserves bounded passive formatting and contact links', () => {
    const html =
      '<table><tr><td><strong>Name</strong><br><a href="mailto:own@example.test">Mail</a></td></tr></table>';
    expect(sanitizeSignatureHtml(html)).toBe(html.replace('<br>', '<br />'));
    expect(renderMailSignature(normalizeMailSignature(signature))).toContain(
      'font-family:Calibri,Arial,sans-serif;font-size:11pt',
    );
    expect(renderMailSignature(normalizeMailSignature(signature))).toContain('<b>Eigener Name</b>');
  });
  it('drops scripts, event handlers, images, forms, SVG, remote CSS and executable links', () => {
    const html =
      '<script>execute()</script><style>@import "https://evil.test";</style>' +
      '<div onclick="execute()" style="background-image:url(https://evil.test/pixel);position:fixed;color:#123456">Name' +
      '<img src="https://evil.test/pixel"><iframe src="https://evil.test">hidden</iframe>' +
      '<svg><script>execute()</script></svg><a href="javascript:execute()">Link</a>' +
      '<a href="//evil.test">Relative</a><a href="data:text/html,test">Data</a></div>';
    const safe = sanitizeSignatureHtml(html);
    expect(safe).toContain('color:#123456');
    expect(safe).not.toMatch(
      /execute|evil|onclick|iframe|svg|script|img|javascript|data:|position|background/,
    );
  });
  it('is stable on repeated sanitization and does not revive encoded markup', () => {
    const safe = sanitizeSignatureHtml('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(sanitizeSignatureHtml(safe)).toBe(safe);
    expect(safe).not.toContain('<img');
  });
  it('preserves individual font sizes and normalizes Outlook pixel sizes with compact paragraphs', () => {
    const html = sanitizeSignatureHtml(
      '<p><span style="font-size:14.666667px">Name</span></p>' +
        '<div style="margin:8pt 0"><span style="font-size:10.5pt">Role</span></div>' +
        '<p style="font-size:8.0pt">Disclaimer</p>',
    );
    expect(html).toContain('<p style="margin:0"><span style="font-size:11pt">Name</span></p>');
    expect(html).toContain('margin:8pt 0');
    expect(html).toContain('font-size:10.5pt');
    expect(html).toContain('font-size:8pt');
    expect(sanitizeSignatureHtml(html)).toBe(html);
    for (const size of [
      '7pt',
      '17pt',
      '100px',
      'var(--size)',
      '12pt!important',
      'calc(12pt)',
      '1e2pt',
    ]) {
      expect(sanitizeSignatureHtml(`<span style="font-size:${size}">X</span>`)).not.toContain(
        'font-size',
      );
    }
  });
  it('keeps one canonical logo marker and rejects forged slots and executable marker children', () => {
    const html = sanitizeSignatureHtml(
      '<div>Role' +
        logoMarker +
        '<span data-kisuno-signature-logo="true">duplicate<script>x()</script></span>Company</div>',
    );
    expect(html.match(/data-kisuno-signature-logo/g)).toHaveLength(1);
    expect(html).not.toMatch(/duplicate|script|x\(\)|data-kisuno-signature-slot/);
    expect(sanitizeSignatureHtml(html)).toBe(html);
    expect(sanitizeSignatureHtml('<br data-kisuno-signature-slot="true">')).toBe('<br />');
    expect(sanitizeSignatureHtml('<div data-kisuno-signature-logo="true">X</div>')).not.toContain(
      'signature-logo',
    );
    const nested = sanitizeSignatureHtml(
      '<span data-kisuno-signature-logo="true"><b>Safe child</b></span>',
    );
    expect(nested).toBe(logoMarker + '<b>Safe child</b>');
    expect(sanitizeSignatureHtml(nested)).toBe(nested);
  });
  it('embeds a bounded logo at the selected position in paragraphs or tables without changing text sizes', async () => {
    const input = await sharp({
      create: { width: 320, height: 100, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer();
    for (const content of [
      `<p>Role${logoMarker}Company</p>`,
      `<table><tr><td>Role${logoMarker}Company</td></tr></table>`,
    ]) {
      const safe = await sanitizeMailSignature({
        ...signature,
        html: content.replace('="true"', '="true" data-kisuno-signature-width="120"'),
        logo: { contentBytes: input.toString('base64') },
      });
      expect(safe.html).toContain('data-kisuno-signature-width="120"');
      const rendered = renderMailSignature(safe, logoCid);
      expect(rendered).toMatch(/Role<img[^>]+>Company/);
      expect(rendered).toContain('width="120" height="38"');
      expect(rendered).not.toContain('data-kisuno');
      expect(rendered.match(/<img/g)).toHaveLength(1);
    }
    const legacy = await sanitizeMailSignature({
      ...signature,
      logo: { contentBytes: input.toString('base64') },
    });
    expect(renderMailSignature(legacy, logoCid)).toMatch(/<\/p><div><img/);
    expect(renderMailSignature(legacy, logoCid)).toContain('width="160" height="50"');
  });
  it('stores display width only in passive HTML and drops invalid width or forged attributes', () => {
    const sized = logoMarker.replace('="true"', '="true" data-kisuno-signature-width="120"');
    const html = sanitizeSignatureHtml(`Name${sized}`);
    expect(html).toContain(sized);
    expect(sanitizeSignatureHtml(html)).toBe(html);
    for (const width of ['0', '79', '321', '-80', '120.5', '80px', '1e2']) {
      const value = logoMarker.replace('="true"', `="true" data-kisuno-signature-width="${width}"`);
      expect(sanitizeSignatureHtml(value)).toBe(logoMarker);
    }
    expect(sanitizeSignatureHtml('<p data-kisuno-signature-width="120">Name</p>')).not.toContain(
      'signature-width',
    );
  });
  it('removes an unused logo marker and does not accept it as visible signature text', () => {
    expect(
      renderMailSignature(
        normalizeMailSignature({ ...signature, html: `Role${logoMarker}Company` }),
      ),
    ).not.toContain('Signatur-Logo');
    expect(() => normalizeMailSignature({ ...signature, html: logoMarker })).toThrow();
  });
  it('requires an explicit bounded configuration and visible signature text', () => {
    for (const invalid of [
      { ...signature, html: 'x'.repeat(20001) },
      { ...signature, html: '<img src="https://example.test/logo.png">' },
      { ...signature, fontFamily: 'url(https://evil.test)' },
      { ...signature, fontSize: 99 },
      { ...signature, extra: true },
      { ...signature, logo: { contentBytes: 'cGl4ZWxz', width: 10000 } },
      { ...signature, enabled: 'true' },
    ])
      expect(() => normalizeMailSignature(invalid)).toThrow();
    expect(renderMailSignature()).toBe('');
    expect(renderMailSignature(normalizeMailSignature({ ...signature, enabled: false }))).toBe('');
  });
  it('removes comments so a pasted signature cannot forge editable reply markers', () => {
    expect(
      sanitizeSignatureHtml(
        '<!-- kisuno-mail-reply:v2 --><p>Name</p><!-- /kisuno-mail-reply:v2 -->',
      ),
    ).toBe('<p style="margin:0">Name</p>');
  });
});
