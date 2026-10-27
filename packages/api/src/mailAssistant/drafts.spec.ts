import sharp from 'sharp';
import { createMailGraph } from './graph';

const original = {
  id: 'original',
  isDraft: false,
  conversationId: 'thread',
  categories: ['Kunde', 'KI: Wichtig'],
};
const quote =
  '<html><head><meta charset="utf-8"></head><body><hr>Von: Kunde<br>Ungekürzter Verlauf ' +
  'x'.repeat(20_000) +
  '<img src="cid:logo"></body></html>';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const file = {
  '@odata.type': '#microsoft.graph.fileAttachment',
  id: 'attachment',
  name: 'Dokument.pdf',
  contentType: 'application/pdf',
  size: 4,
  isInline: false,
};

function setup(options: { files?: object[]; bytes?: Uint8Array; quote?: string } = {}) {
  let body = options.quote ?? quote;
  let etag = 'W/"created"';
  let exists = false;
  const sourceFiles = options.files ?? [];
  const copied: object[] = [];
  const beforeRequest = jest.fn().mockResolvedValue(undefined);
  const token = jest.fn().mockResolvedValue('private-token');
  const draft = () => ({
    id: 'draft',
    isDraft: true,
    conversationId: 'thread',
    '@odata.etag': etag,
    body: { contentType: 'html', content: body },
    webLink: 'https://outlook.office.com/mail/draft',
  });
  const implementation = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://outlook.office.com/')) {
      const range = (init?.headers as Record<string, string>)['Content-Range'];
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
      const next = Number(match[2]) + 1;
      return next === Number(match[3])
        ? new Response(null, { status: 201 })
        : json({ nextExpectedRanges: [`${next}-`] });
    }
    const path = new URL(url).pathname;
    if (path === '/v1.0/me/messages/original' && method === 'GET') return json(original);
    if (path === '/v1.0/me/messages/original/attachments' && method === 'GET')
      return json({ value: sourceFiles });
    if (path.endsWith('/$value'))
      return new Response(new Uint8Array(options.bytes ?? [1, 2, 3, 4]));
    if (path === '/v1.0/me/messages/original/createReply' && method === 'POST') {
      exists = true;
      return json(draft(), 201);
    }
    if (path === '/v1.0/me/messages/draft' && method === 'GET' && exists) return json(draft());
    if (path === '/v1.0/me/messages/draft' && method === 'PATCH' && exists) {
      if ((init?.headers as Record<string, string>)['If-Match'] !== etag) return json({}, 412);
      const patch = JSON.parse(String(init?.body));
      body = patch.body.content;
      etag = 'W/"patched"';
      return json(draft());
    }
    if (path === '/v1.0/me/messages/draft/attachments' && method === 'GET')
      return json({
        value: copied.map((item, index) => ({ id: `copy-${index + 1}`, size: 4, ...item })),
      });
    if (path === '/v1.0/me/messages/draft/attachments' && method === 'POST') {
      copied.push(JSON.parse(String(init?.body)));
      return json({ id: `copy-${copied.length}` }, 201);
    }
    if (path === '/v1.0/me/messages/draft/attachments/createUploadSession' && method === 'POST')
      return json(
        {
          uploadUrl:
            "https://outlook.office.com/api/v2.0/Users('own')/Messages('draft-rest-id')/AttachmentSessions('session')?authtoken=private-upload-token",
          expirationDateTime: '2099-01-01T00:00:00Z',
          nextExpectedRanges: ['0-'],
        },
        201,
      );
    throw new Error('Unexpected fixture request');
  };
  const request = jest.fn(implementation);
  return {
    request,
    beforeRequest,
    token,
    implementation,
    copied,
    graph: createMailGraph({ fetch: request, beforeRequest, token }),
    body: () => body,
    alter: (nextBody: string) => {
      body = nextBody;
      etag = 'W/"employee"';
    },
  };
}

describe('complete, own reply drafts', () => {
  test('attaches an explicitly uploaded signature logo once using a fresh inline CID', async () => {
    const state = setup();
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } })
      .png()
      .toBuffer();
    const result = await state.graph.createReply('original', 'Guten Tag\n\nDanke.', {
      enabled: true,
      html: '<p>Eigener Name</p>',
      fontFamily: 'Calibri',
      fontSize: 11,
      logo: { contentBytes: png.toString('base64') },
    });
    expect(result).not.toHaveProperty('warnings');
    expect(state.copied).toHaveLength(1);
    expect(state.copied[0]).toMatchObject({
      name: 'signatur-logo.png',
      contentType: 'image/png',
      isInline: true,
      contentId: expect.stringMatching(/^kisuno-signature-[a-f0-9-]{36}$/),
    });
    const logo = state.copied[0] as { contentId: string; contentBytes: string };
    expect(state.body()).toContain(`src="cid:${logo.contentId}"`);
    expect(state.body()).not.toContain(logo.contentBytes);
    await state.graph.editDraft('draft', 'Überarbeitete Antwort', 'W/"patched"');
    expect(state.copied).toHaveLength(1);
    expect(state.body()).toContain(`src="cid:${logo.contentId}"`);
    expect(
      state.request.mock.calls.every(([url]) =>
        String(url).startsWith('https://graph.microsoft.com/v1.0/me/'),
      ),
    ).toBe(true);
  });
  test('rejects invalid signature image data before any mailbox request', async () => {
    const state = setup();
    await expect(
      state.graph.createReply('original', 'Danke', {
        enabled: true,
        html: '<p>Eigener Name</p>',
        fontFamily: 'Calibri',
        fontSize: 11,
        logo: { contentBytes: Buffer.from('<svg/>').toString('base64') },
      }),
    ).rejects.toThrow();
    expect(state.request).not.toHaveBeenCalled();
  });
  test('keeps the personal reply font after editing even with signature text disabled', async () => {
    const state = setup();
    await expect(
      state.graph.createReply('original', 'Guten Tag\n\nDanke.', {
        enabled: false,
        html: '<p>Nicht anhängen</p>',
        fontFamily: 'Aptos',
        fontSize: 12,
      }),
    ).resolves.not.toHaveProperty('warnings');
    expect(state.body()).toContain('font-family:Aptos,Arial,sans-serif;font-size:12pt');
    expect(state.body()).not.toContain('Nicht anhängen');
    await state.graph.editDraft('draft', 'Überarbeitete Antwort', 'W/"patched"');
    expect(state.body()).toContain('font-family:Aptos,Arial,sans-serif;font-size:12pt');
    expect(state.body()).not.toContain('font-size:11pt');
  });
  test('retains the entire native quoted body, copies categories, escapes reply, never sets recipients or sends', async () => {
    const { graph, request, body } = setup();
    await expect(
      graph.createReply('original', '<script>secret</script>\n\nDanke\nGruss'),
    ).resolves.toEqual({
      id: 'draft',
      url: 'https://outlook.office.com/mail/draft',
    });
    expect(body()).toContain('x'.repeat(20_000));
    expect(body()).toContain('<img src="cid:logo">');
    expect(body()).toContain('&lt;script&gt;secret&lt;/script&gt;</p>');
    expect(body()).toContain('>Danke<br>Gruss</p>');
    expect(body()).toContain('font-size:11pt');
    expect(body()).toContain('margin:0 0 12pt 0');
    const create = request.mock.calls.find(([url]) => String(url).endsWith('/createReply'))!;
    expect(create[1]?.body).toBeUndefined();
    expect((create[1]?.headers as Record<string, string>).Prefer).toContain(
      'body-content-type="html"',
    );
    const patch = request.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]?.body)).categories).toEqual(original.categories);
    expect(request.mock.calls.every(([url]) => !String(url).match(/send|\/users\//))).toBe(true);
    expect(
      request.mock.calls.every(
        ([, init]) => !String(init?.body).match(/toRecipients|ccRecipients|bccRecipients/),
      ),
    ).toBe(true);
  });
  test('copies actual file bytes directly between own original and draft', async () => {
    const { graph, copied, request } = setup({ files: [file] });
    await expect(graph.createReply('original', 'Danke')).resolves.not.toHaveProperty('warnings');
    expect(copied).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'Dokument.pdf',
        contentType: 'application/pdf',
        isInline: false,
        contentBytes: 'AQIDBA==',
      },
    ]);
    const download = request.mock.calls.find(([url]) => String(url).endsWith('/$value'))!;
    expect((download[1]?.headers as Record<string, string>).Accept).toBe('*/*');
    const listing = request.mock.calls.find(([url]) =>
      String(url).includes('/original/attachments?'),
    )!;
    expect(new URL(String(listing[0])).searchParams.get('$select')).toContain(
      'microsoft.graph.fileAttachment/contentId',
    );
    expect(new URL(String(listing[0])).searchParams.get('$select')).not.toContain('contentBytes');
  });
  test('adds only the explicitly configured signature and preserves it while editing the answer', async () => {
    const state = setup({ files: [file] });
    await state.graph.createReply('original', 'Guten Tag\n\nDanke für die Nachricht.', {
      enabled: true,
      html: '<p>Freundliche Grüsse<br><b>Eigener Name</b><img src="https://tracker.test/logo"></p>',
      fontFamily: 'Calibri',
      fontSize: 12,
    });
    expect(state.body()).toContain('font-size:12pt');
    expect(state.body()).not.toContain('tracker.test');
    expect((await state.graph.editableReply('draft')).text).toBe(
      'Guten Tag\n\nDanke für die Nachricht.',
    );
    const signature = state.body().slice(state.body().indexOf('<!-- kisuno-mail-signature:v1 -->'));
    await state.graph.editDraft('draft', 'Geprüfte neue Antwort', 'W/"patched"');
    expect(state.body().slice(state.body().indexOf('<!-- kisuno-mail-signature:v1 -->'))).toBe(
      signature,
    );
    expect(state.copied).toHaveLength(1);
  });
  test('upgrades a legacy reply block without changing the quoted message', async () => {
    const state = setup();
    await state.graph.createReply('original', 'Initial');
    state.alter(
      '<html><body><!-- kisuno-mail-reply:v1 --><p>Alte Antwort</p><!-- /kisuno-mail-reply:v1 --><hr>Verlauf</body></html>',
    );
    expect((await state.graph.editableReply('draft')).text).toBe('Alte Antwort');
    await state.graph.editDraft('draft', 'Neue Antwort', 'W/"employee"');
    expect(state.body()).toContain('<!-- kisuno-mail-reply:v2 -->');
    expect(state.body()).toContain('font-size:11pt');
    expect(state.body()).toContain('<hr>Verlauf</body></html>');
  });
  test('does not overwrite an Outlook-formatted response with unsupported markup', async () => {
    const state = setup();
    await state.graph.createReply('original', 'Antwort');
    state.alter(state.body().replace('font-size:11pt', 'font-size:18pt'));
    await expect(state.graph.editableReply('draft')).rejects.toThrow('formatiert');
    const count = state.request.mock.calls.length;
    await expect(state.graph.editDraft('draft', 'Anderer Text', 'W/"employee"')).rejects.toThrow(
      'formatiert',
    );
    expect(state.request.mock.calls.slice(count).every(([, init]) => init?.method === 'GET')).toBe(
      true,
    );
  });
  test('normalizes CRLF and paragraph whitespace consistently without a spurious incomplete warning', async () => {
    const state = setup();
    await expect(
      state.graph.createReply('original', 'Danke\r\n\r\n\r\nGruss\r\nName'),
    ).resolves.not.toHaveProperty('warnings');
    expect(await state.graph.editableReply('draft')).toMatchObject({
      text: 'Danke\n\nGruss\nName',
    });
  });
  test('preserves CID and inline metadata while copying embedded original images', async () => {
    const { graph, copied } = setup({
      files: [{ ...file, isInline: true, contentId: 'logo', name: 'logo.png' }],
    });
    await graph.createReply('original', 'Danke');
    expect(copied[0]).toMatchObject({ isInline: true, contentId: 'logo' });
  });
  test('uploads large files in bounded sequential ranges without sending Graph bearer token to the upload URL', async () => {
    const { graph, request } = setup({
      files: [{ ...file, size: 3_000_004 }],
      bytes: new Uint8Array(3_000_004),
    });
    await expect(graph.createReply('original', 'Danke')).resolves.not.toHaveProperty('warnings');
    const puts = request.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(
      puts.map(([, init]) => (init?.headers as Record<string, string>)['Content-Range']),
    ).toEqual(['bytes 0-2999999/3000004', 'bytes 3000000-3000003/3000004']);
    for (const [, init] of puts) {
      expect(init?.headers).not.toHaveProperty('Authorization');
      expect(init?.redirect).toBe('error');
    }
  });
  test.each([
    'https://attacker.test/upload?authtoken=private',
    "https://outlook.office.com.attacker.test/api/v2.0/Users('own')/Messages('draft')/AttachmentSessions('x')?authtoken=private",
    "https://user:pass@outlook.office.com/api/v2.0/Users('own')/Messages('draft')/AttachmentSessions('x')?authtoken=private",
    'https://outlook.office.com/api/v2.0/me/sendMail?authtoken=private',
    "https://outlook.office.com/api/v2.0/Users('own')/Messages('draft')/AttachmentSessions('x')?authtoken=private#secret",
  ])('never follows an unsafe upload target %s', async (uploadUrl) => {
    const state = setup({
      files: [{ ...file, size: 3_000_004 }],
      bytes: new Uint8Array(3_000_004),
    });
    state.request.mockImplementation(async (url, init) =>
      String(url).endsWith('/createUploadSession')
        ? json(
            { uploadUrl, expirationDateTime: '2099-01-01T00:00:00Z', nextExpectedRanges: ['0-'] },
            201,
          )
        : state.implementation(url, init),
    );
    const result = await state.graph.createReply('original', 'Danke');
    expect(result.warnings?.join()).toMatch(/sichere Übertragung/);
    expect(result.warnings?.join()).not.toMatch(/private|authtoken|attacker/);
    expect(state.request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });
  test('a partially failed attachment copy preserves known draft and warns without retry or duplicate creation', async () => {
    const state = setup({ files: [file] });
    state.request.mockImplementation(async (url, init) =>
      String(url).endsWith('/draft/attachments') && init?.method === 'POST'
        ? Promise.reject(Error('private-token private-mail'))
        : state.implementation(url, init),
    );
    const result = await state.graph.createReply('original', 'Danke');
    expect(result.id).toBe('draft');
    expect(result.warnings?.join()).toContain('unvollständig');
    expect(result.stop).toBe(true);
    expect(result.warnings?.join()).not.toContain('private');
    expect(
      state.request.mock.calls.filter(([url]) => String(url).endsWith('/createReply')),
    ).toHaveLength(1);
    expect(state.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });
  test.each(['microsoft.graph.referenceAttachment', 'microsoft.graph.itemAttachment'])(
    'unsupported %s is disclosed, and no arbitrary source URL is fetched',
    async (type) => {
      const state = setup({
        files: [{ ...file, '@odata.type': type, sourceUrl: 'https://secret-intranet/file' }],
      });
      const result = await state.graph.createReply('original', 'Danke');
      expect(result.warnings?.join()).toContain('nicht kopiert');
      expect(
        state.request.mock.calls.every(([url]) =>
          String(url).startsWith('https://graph.microsoft.com/v1.0/me/'),
        ),
      ).toBe(true);
      expect(state.request.mock.calls.some(([url]) => String(url).endsWith('/$value'))).toBe(false);
    },
  );
  test('oversized attachment is visibly omitted without fetching its bytes', async () => {
    const state = setup({ files: [{ ...file, size: 150_000_001 }] });
    const result = await state.graph.createReply('original', 'Danke');
    expect(result.warnings?.join()).toContain('150 MB');
    expect(state.request.mock.calls.some(([url]) => String(url).endsWith('/$value'))).toBe(false);
  });
  test('a truncated download cannot produce an apparently complete draft', async () => {
    const state = setup({ files: [{ ...file, size: 10 }] });
    const result = await state.graph.createReply('original', 'Danke');
    expect(result.warnings?.join()).toContain('unvollständig');
    expect(result.stop).toBe(true);
    expect(state.copied).toEqual([]);
  });
  test('ambiguous draft creation is not retried', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      String(url).endsWith('/createReply')
        ? Promise.reject(Error('private-token'))
        : state.implementation(url, init),
    );
    await expect(state.graph.createReply('original', 'Danke')).rejects.toMatchObject({
      uncertain: true,
    });
    expect(
      state.request.mock.calls.filter(([url]) => String(url).endsWith('/createReply')),
    ).toHaveLength(1);
  });
  test('employee changes between creation and first read are never overwritten', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) => {
      const result = await state.implementation(url, init);
      if (String(url).endsWith('/createReply'))
        state.alter('<html><body>Meine Antwort</body></html>');
      return result;
    });
    const result = await state.graph.createReply('original', 'KI-Antwort');
    expect(result.warnings?.join()).toContain('inzwischen verändert');
    expect(state.body()).toContain('Meine Antwort');
    expect(state.request.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
  test('editing changes only the bounded answer, retaining quotes, CID references and attachments', async () => {
    const state = setup({ files: [file] });
    await state.graph.createReply('original', 'Danke\n\nGruss');
    expect(await state.graph.editableReply('draft')).toEqual({
      text: 'Danke\n\nGruss',
      etag: 'W/"patched"',
    });
    const count = state.request.mock.calls.length;
    await state.graph.editDraft('draft', 'Neue Antwort <b>bleibt Text</b>', 'W/"patched"');
    expect(state.body()).toContain('Neue Antwort &lt;b&gt;bleibt Text&lt;/b&gt;');
    expect(state.body()).toContain('x'.repeat(20_000));
    expect(state.body()).toContain('<img src="cid:logo">');
    expect(state.request.mock.calls.slice(count).map(([, init]) => init?.method)).toEqual([
      'GET',
      'PATCH',
    ]);
    const patch = JSON.parse(
      String(state.request.mock.calls[state.request.mock.calls.length - 1]?.[1]?.body),
    );
    expect(Object.keys(patch)).toEqual(['body']);
    expect(state.copied).toHaveLength(1);
  });
  test('stale editor version cannot overwrite an employee change', async () => {
    const state = setup();
    await state.graph.createReply('original', 'Danke');
    state.alter(state.body().replace('Danke', 'Von Mitarbeiter überarbeitet'));
    const count = state.request.mock.calls.length;
    await expect(state.graph.editDraft('draft', 'KI Text', 'W/"patched"')).rejects.toMatchObject({
      status: 412,
    });
    expect(state.body()).toContain('Von Mitarbeiter überarbeitet');
    expect(state.request.mock.calls.slice(count).every(([, init]) => init?.method === 'GET')).toBe(
      true,
    );
  });
  test('legacy draft and an Outlook-modified answer fail closed instead of replacing the whole body', async () => {
    const state = setup();
    await state.graph.createReply('original', 'Danke');
    state.alter('<html><body>Manueller Entwurf ohne Marker<hr>Verlauf</body></html>');
    await expect(state.graph.editableReply('draft')).rejects.toThrow(
      'keinen unveränderten Antwortbereich',
    );
    await expect(state.graph.editDraft('draft', 'KI Text', 'W/"employee"')).rejects.toThrow(
      'keinen unveränderten Antwortbereich',
    );
  });
  test('revoked consent aborts the pipeline rather than returning successful warnings', async () => {
    const state = setup({ files: [file] });
    state.request.mockImplementation(async (url, init) => {
      const result = await state.implementation(url, init);
      if (init?.method === 'PATCH') state.beforeRequest.mockRejectedValue(new Error('paused'));
      return result;
    });
    await expect(state.graph.createReply('original', 'Danke')).rejects.toThrow('paused');
    expect(state.copied).toEqual([]);
  });
  test('Graph auth failure after creation remains uncertain and blocks a blind replay', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      String(url).includes('/draft?') ? json({}, 401) : state.implementation(url, init),
    );
    await expect(state.graph.createReply('original', 'Danke')).rejects.toMatchObject({
      status: 401,
      uncertain: true,
    });
  });
});
