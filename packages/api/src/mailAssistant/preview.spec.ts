import sharp from 'sharp';
import { createMailGraph } from './graph';
import { previewRaster, sanitizeMailPreview } from './preview';

describe('isolated mail HTML preview', () => {
  let png: Buffer;
  beforeAll(async () => {
    png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#f00' } })
      .png()
      .toBuffer();
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  function setup(html = '<p>Mail</p>') {
    const request = jest
      .fn()
      .mockResolvedValue(json({ id: 'mail', body: { contentType: 'html', content: html } }));
    const guard = jest.fn().mockResolvedValue(undefined);
    return {
      request,
      guard,
      graph: createMailGraph({
        fetch: request,
        token: async () => 'private-fixture-token',
        beforeRequest: guard,
      }),
    };
  }
  test('preserves common Outlook formatting and tables without navigation', () => {
    const result = sanitizeMailPreview(
      '<html><head><style>@import "https://tracker.test";</style></head><body><font face="Calibri" color="#112233" size="3">Hallo</font><table style="border-collapse:collapse;width:100%"><tr><td colspan="2" style="font-size:12pt;color:#123456;padding:4px 8px">Text <b>fett</b><br><a href="https://tracker.test" target="_top">Link</a></td></tr></table></body></html>',
    );
    expect(result.html).toContain('<table style="border-collapse:collapse;width:100%">');
    expect(result.html).toContain('font-family:Calibri');
    expect(result.html).toContain('colspan="2"');
    expect(result.html).toContain('font-size:12pt');
    expect(result.html).toContain('<b>fett</b>');
    expect(result.html).not.toMatch(/href=|target=|tracker|<style|<html|<body/);
  });
  test.each([
    '<script>alert(document.cookie)</script><p onclick="alert(1)">Text</p>',
    '<svg onload="alert(1)"><foreignObject><iframe src="https://tracker.test"></iframe></foreignObject></svg>',
    '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
    '<form action="https://tracker.test"><input name="password"><button formaction="https://tracker.test">Login</button></form>',
    '<meta http-equiv="refresh" content="0;url=https://tracker.test"><base href="https://tracker.test">',
    '<object data="https://tracker.test"><embed src="https://tracker.test"></object>',
    '<video poster="https://tracker.test"><source src="https://tracker.test"></video>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<template shadowrootmode="open"><img src="https://tracker.test"></template>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p>',
  ])('removes active namespaces, executable attributes and network sinks: %s', (payload) => {
    const result = sanitizeMailPreview(payload);
    expect(result.html).not.toMatch(
      /<(?:script|svg|math|form|input|button|iframe|object|embed|video|source|meta|base|template|noscript)\b|\son[a-z]+=|\s(?:src|href|action|poster|srcdoc)=/i,
    );
  });
  test('does not load remote, relative, protocol-relative, original data or malformed CID images', () => {
    const result = sanitizeMailPreview(
      '<img src="https://tracker.test/pixel"><img src="//tracker.test/pixel"><img src="/api/private"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="cid:%ZZ"><img srcset="https://tracker.test/2 2x" src="cid:image">',
    );
    expect(result.blockedImages).toBe(6);
    expect(result.references).toEqual(new Set(['image']));
    expect(result.html).not.toMatch(/<img|srcset|tracker|data:|cid:/);
  });
  test.each([
    'background:url(https://tracker.test);color:#123456',
    'background-image:url(data:image/svg+xml,x);font-weight:bold',
    'behavior:url(x);position:fixed;z-index:999999;cursor:url(x)',
    'color:expression(alert(1));background:u\\72l(https://tracker.test)',
    'font-family:var(--secret);width:calc(100% + 1px);filter:url(#x)',
    'background-color:red;--tracker:url(https://tracker.test);content:attr(data-secret)',
  ])('strict CSS values strip external fetches and overlay primitives: %s', (style) => {
    const result = sanitizeMailPreview(`<p style="${style}">Mail</p>`);
    expect(result.html).not.toMatch(
      /url|expression|behavior|position|z-index|cursor|var\(|calc\(|filter|--tracker|content:|tracker/i,
    );
  });
  test('limits repeated embedded image expansion as well as distinct attachments', () => {
    const data = `data:image/png;base64,${png.toString('base64')}`;
    const result = sanitizeMailPreview('<img src="cid:a">'.repeat(1000), new Map([['a', data]]));
    expect((result.html.match(/<img/g) || []).length).toBe(8);
    expect(result.blockedImages).toBe(992);
    expect(result.html.length).toBeLessThan(100_000);
  });
  test('rejects parser complexity rather than exhausting deep DOM work', () => {
    expect(() => sanitizeMailPreview('<p>x</p>'.repeat(20_001))).toThrow();
  });
  test('raster decoding rejects SVG, XML and fake signature polyglots', async () => {
    await expect(
      previewRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    ).rejects.toThrow();
    await expect(
      previewRaster(Buffer.concat([png.subarray(0, 8), Buffer.from('<svg/>')])),
    ).rejects.toThrow();
    await expect(previewRaster(Buffer.alloc(1_000_001))).rejects.toThrow();
  });
  test('raster decoding re-encodes pixels and removes input metadata', async () => {
    const source = await sharp(png).withMetadata().jpeg().toBuffer();
    const result = await previewRaster(source);
    const metadata = await sharp(result).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 2, height: 2 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });
  test('rejects decompression-sized raster before rendering', async () => {
    const large = await sharp({
      create: { width: 2100, height: 2100, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await expect(previewRaster(large)).rejects.toThrow();
  });
  test('fetches HTML only on explicit preview and only from own fixed message path', async () => {
    const { graph, request } = setup('<p style="color:blue">Mail</p>');
    const result = await graph.preview('mail');
    expect(result).toMatchObject({
      html: '<p style="color:blue">Mail</p>',
      blockedImages: 0,
      truncated: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/mail?$select=id,body');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.headers.Prefer).toContain('outlook.body-content-type="html"');
  });
  test('bounds huge HTML and escapes plain text', async () => {
    const { graph, request } = setup('x'.repeat(1_000_001));
    expect(await graph.preview('mail')).toMatchObject({ truncated: true });
    request.mockResolvedValueOnce(
      json({
        id: 'mail',
        body: { contentType: 'text', content: '<img src="https://tracker.test">' },
      }),
    );
    const plain = await graph.preview('mail');
    expect(plain.html).toContain('&lt;img');
    expect(plain.html).not.toContain('<img');
    request.mockResolvedValueOnce(
      json({ id: 'mail', body: { contentType: 'text', content: '&'.repeat(250_000) } }),
    );
    expect(await graph.preview('mail')).toMatchObject({ truncated: true });
  });
  test('copies only matched bounded raster CID bytes and never sends mailbox token externally', async () => {
    const { graph, request, guard } = setup();
    request
      .mockResolvedValueOnce(
        json({
          id: 'mail',
          body: {
            contentType: 'html',
            content: '<img src="cid:logo"><img src="https://tracker.test/pixel">',
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          value: [
            {
              id: 'image/+==',
              '@odata.type': '#microsoft.graph.fileAttachment',
              contentId: 'logo',
              contentType: 'image/png',
              size: png.length,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from(png)));
    const result = await graph.preview('mail');
    expect(result.html).toContain('data:image/png;base64,');
    expect(result.blockedImages).toBe(1);
    expect(result.html).not.toContain('tracker.test');
    expect(request.mock.calls[2][0]).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/mail/attachments/image%2F%2B%3D%3D/$value',
    );
    expect(
      request.mock.calls.every(
        ([url, options]) =>
          String(url).startsWith('https://graph.microsoft.com/v1.0/me/') &&
          options.method === 'GET',
      ),
    ).toBe(true);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
  test.each(['reference', 'oversize', 'duplicate', 'svg'])(
    'blocks unsafe attachment metadata without downloading: %s',
    async (kind) => {
      const { graph, request } = setup();
      const attachment = {
        id: 'image',
        '@odata.type': '#microsoft.graph.fileAttachment',
        contentId: 'logo',
        contentType: 'image/png',
        size: png.length,
      };
      if (kind === 'reference') attachment['@odata.type'] = '#microsoft.graph.referenceAttachment';
      if (kind === 'oversize') attachment.size = 1_000_001;
      if (kind === 'svg') attachment.contentType = 'image/svg+xml';
      request
        .mockResolvedValueOnce(
          json({ id: 'mail', body: { contentType: 'html', content: '<img src="cid:logo">' } }),
        )
        .mockResolvedValueOnce(
          json({ value: kind === 'duplicate' ? [attachment, attachment] : [attachment] }),
        );
      expect(await graph.preview('mail')).toMatchObject({ blockedImages: 1 });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  test('wrong message identity aborts before attachment discovery', async () => {
    const { graph, request } = setup();
    request.mockResolvedValueOnce(
      json({ id: 'other-mail', body: { contentType: 'html', content: '<img src="cid:logo">' } }),
    );
    await expect(graph.preview('mail')).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('revocation during attachment processing is not converted into a partial success', async () => {
    const { graph, request, guard } = setup();
    request.mockResolvedValueOnce(
      json({ id: 'mail', body: { contentType: 'html', content: '<img src="cid:logo">' } }),
    );
    guard
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(graph.preview('mail')).rejects.toThrow('revoked');
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('authorization errors do not yield cached HTML success', async () => {
    const { graph, request } = setup();
    request
      .mockResolvedValueOnce(
        json({ id: 'mail', body: { contentType: 'html', content: '<img src="cid:logo">' } }),
      )
      .mockResolvedValueOnce(json({}, 403));
    await expect(graph.preview('mail')).rejects.toMatchObject({ status: 403 });
  });
  test('damaged image bytes leave a blocked placeholder without exposing diagnostics', async () => {
    const { graph, request } = setup();
    request
      .mockResolvedValueOnce(
        json({ id: 'mail', body: { contentType: 'html', content: '<img src="cid:logo">' } }),
      )
      .mockResolvedValueOnce(
        json({
          value: [
            {
              id: 'image',
              '@odata.type': '#microsoft.graph.fileAttachment',
              contentId: 'logo',
              contentType: 'image/png',
              size: 3,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response('bad'));
    const result = await graph.preview('mail');
    expect(result).toMatchObject({ blockedImages: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture-token|https:|libvips|bad/);
  });
  test('the shared preview time budget prevents a slow mail from starting more image requests', async () => {
    const { graph, request } = setup();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    request.mockImplementationOnce(async () => {
      clock.mockReturnValue(27_000);
      return json({
        id: 'mail',
        body: { contentType: 'html', content: '<p>Mail</p><img src="cid:logo">' },
      });
    });
    try {
      const result = await graph.preview('mail');
      expect(result).toMatchObject({ blockedImages: 1 });
      expect(result.warnings).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
