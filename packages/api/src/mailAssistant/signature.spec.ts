import sharp from 'sharp';
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
  it('requires an explicit bounded configuration and visible signature text', () => {
    for (const invalid of [
      { ...signature, html: 'x'.repeat(20001) },
      { ...signature, html: '<img src="https://example.test/logo.png">' },
      { ...signature, fontFamily: 'url(https://evil.test)' },
      { ...signature, fontSize: 99 },
      { ...signature, extra: true },
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
    ).toBe('<p>Name</p>');
  });
});
