import { createMailGraph, MailGraphError, safeOutlookUrl } from './graph';

describe('fixed personal Graph adapter', () => {
  const row = {
    id: 'id/+==',
    conversationId: 'thread',
    receivedDateTime: '2026-10-26T08:00:00Z',
    categories: ['Kunde'],
    isDraft: false,
  };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  function setup() {
    const request = jest.fn().mockResolvedValue(response(row));
    const beforeRequest = jest.fn().mockResolvedValue(undefined);
    const token = jest.fn().mockResolvedValue('private-token');
    return {
      request,
      beforeRequest,
      token,
      graph: createMailGraph({ fetch: request, token, beforeRequest }),
    };
  }
  test('categories cannot mutate unread, recipients, folders or mail body', async () => {
    const { graph, request } = setup();
    await graph.categorize(row.id, ['Kunde', 'KI: Wichtig'], 'W/"current"');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F%2B%3D%3D');
    expect(init.method).toBe('PATCH');
    expect(init.headers['If-Match']).toBe('W/"current"');
    expect(JSON.parse(init.body)).toEqual({ categories: ['Kunde', 'KI: Wichtig'] });
    expect(init.redirect).toBe('error');
    expect(init.headers.Prefer).toContain('ImmutableId');
    expect(Object.keys(graph).sort()).toEqual([
      'categorize',
      'createReply',
      'historyPage',
      'identity',
      'message',
      'page',
      'thread',
    ]);
  });
  test('reply creation escapes HTML, never sets recipients or calls send', async () => {
    const { graph, request } = setup();
    request.mockResolvedValue(
      response({ id: 'draft', isDraft: true, webLink: 'https://outlook.office.com/mail/draft' }),
    );
    await expect(
      graph.createReply(row.id, '<script>alert(1)</script>\n\nDanke\nGruss'),
    ).resolves.toEqual({ id: 'draft', url: 'https://outlook.office.com/mail/draft' });
    expect(request.mock.calls[0][0]).toMatch(/\/me\/messages\/[^/]+\/createReply$/);
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(Object.keys(body)).toEqual(['message']);
    expect(Object.keys(body.message)).toEqual(['body']);
    expect(body.message.body.content).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>Danke<br>Gruss</p>',
    );
  });
  test.each([
    'https://attacker.test/v1.0/me/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com/v1.0/users/other/mailFolders/inbox/messages/delta',
    'https://graph.microsoft.com/v1.0/me/sendMail',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
  ])('rejects injected delta URL %s', async (url) => {
    const { graph, request } = setup();
    await expect(graph.page('2026-10-26T08:00:00Z', url)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  test('accepts server delta link for the resolved own folder', async () => {
    const { graph, request } = setup();
    const url =
      "https://graph.microsoft.com/v1.0/me/mailfolders('AQMk123==')/messages/delta?$deltatoken=abc";
    request.mockResolvedValue(response({ value: [row], '@odata.deltaLink': url }));
    expect((await graph.page('2026-10-26T08:00:00Z', url)).nextUrl).toBe(url);
  });
  test('distinguishes empty live nextLink pages from a completed delta round', async () => {
    const { graph, request } = setup();
    const url =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=opaque';
    request.mockResolvedValueOnce(response({ value: [], '@odata.nextLink': url }));
    expect(await graph.page('2026-10-26T08:00:00Z')).toMatchObject({ messages: [], hasMore: true });
    request.mockResolvedValueOnce(
      response({ value: [], '@odata.deltaLink': url.replace('$skiptoken', '$deltatoken') }),
    );
    expect(await graph.page('2026-10-26T08:00:00Z', url)).toMatchObject({
      messages: [],
      hasMore: false,
    });
  });
  test.each([undefined, '2026-10-23T22:00:00Z'])(
    'history reads only bounded inbox metadata, latest first (%s)',
    async (from) => {
      const { graph, request } = setup();
      request.mockResolvedValue(response({ value: [row] }));
      expect(await graph.historyPage(from, '2026-10-26T07:00:00Z')).toMatchObject({
        messages: [expect.objectContaining({ body: '' })],
        hasMore: false,
      });
      const url = new URL(request.mock.calls[0][0]);
      expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
      expect(url.searchParams.get('$filter')).toBe(
        `${from ? 'receivedDateTime ge 2026-10-23T22:00:00.000Z and ' : ''}receivedDateTime lt 2026-10-26T07:00:00.000Z`,
      );
      expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
      expect(url.searchParams.get('$select')?.split(',')).not.toContain('body');
    },
  );
  test('historical pagination preserves an opaque next link and has a real terminal page', async () => {
    const { graph, request } = setup();
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=20&$filter=opaque';
    request.mockResolvedValueOnce(response({ value: [], '@odata.nextLink': next }));
    expect(await graph.historyPage(undefined, '2026-10-26T07:00:00Z')).toEqual({
      messages: [],
      nextUrl: next,
      hasMore: true,
    });
    request.mockResolvedValueOnce(response({ value: [] }));
    expect(await graph.historyPage(undefined, '2026-10-26T07:00:00Z', next)).toEqual({
      messages: [],
      hasMore: false,
    });
    expect(request.mock.calls[1][0]).toBe(next);
  });
  test.each([
    "mailFolders('inbox')",
    "mailfolders('AQMk123-_+=')",
    "mailFolders('AQMk123-_%2B%3D')",
    'mailFolders(%27inbox%27)',
    'mailFolders(%27AQMk123-_%2B%3D%27)',
    "mailFolders(%27AQMk123-_%2B%3D')",
    'mailFolders/AQMk123-_+=',
    'mailFolders/AQMk123-_%2b%3d',
  ])('reads the first and next historical page with Graph folder form %s', async (folder) => {
    const { graph, request } = setup();
    const next =
      `https://graph.microsoft.com/v1.0/me/${folder}/messages` +
      "?$skiptoken=opaque%2Bvalue%2f%3D&custom=a'b+Ω&$filter=receivedDateTime%20lt%202026-10-26T07%3A00%3A00Z";
    request.mockResolvedValueOnce(response({ value: [row], '@odata.nextLink': next }));
    const first = await graph.historyPage(undefined, '2026-10-26T07:00:00Z');
    expect(first).toEqual({
      messages: [expect.objectContaining({ id: row.id, body: '' })],
      nextUrl: next,
      hasMore: true,
    });
    request.mockResolvedValueOnce(response({ value: [] }));
    expect(await graph.historyPage(undefined, '2026-10-26T07:00:00Z', first.nextUrl)).toEqual({
      messages: [],
      hasMore: false,
    });
    expect(request.mock.calls[1][0]).toBe(next);
    expect(request.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET']);
  });
  test.each([
    'https://attacker.test/v1.0/me/mailFolders/inbox/messages',
    'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com:444/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com.attacker.test/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/users/other/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages',
    "https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages",
    'https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages',
    "https://graph.microsoft.com/v1.0/me/mailFolders('deleteditems')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('%73entitems')/messages",
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/childFolders/AQMk123/messages',
    'https://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    'https://name:secret@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages#',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages#fragment',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages\n',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/../inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/%2e%2e/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders\\inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/AQMk%2F123/messages',
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%5C123')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%2E123')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%00123')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%27123')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%252F123')/messages",
    'https://graph.microsoft.com/v1.0/me/mailFolders(%2527inbox%2527)/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders%28%27inbox%27%29/messages',
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%123')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('AQMk%ZZ')/messages",
    "https://graph.microsoft.com/v1.0/me/mailFolders('')/messages",
  ])('rejects unsafe historical next link %s', async (url) => {
    const { graph, request, token, beforeRequest } = setup();
    await expect(graph.historyPage(undefined, '2026-10-26T07:00:00Z', url)).rejects.toThrow(
      'Die nächste Posteingangsseite von Microsoft konnte nicht sicher geprüft werden.',
    );
    expect(request).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
  });
  test('rejects an unsafe link in a Graph response without leaking it or following it', async () => {
    const { graph, request } = setup();
    const next = 'https://attacker.test/private-folder?token=private-token';
    request.mockResolvedValueOnce(response({ value: [row], '@odata.nextLink': next }));
    const error = await graph
      .historyPage(undefined, '2026-10-26T07:00:00Z')
      .catch((value) => value);
    expect(error).toBeInstanceOf(MailGraphError);
    expect(error.status).toBe(400);
    expect(error.message).not.toMatch(/attacker|private-folder|private-token|nicht erreichbar/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('rechecks pause after obtaining token and never sends request if stopped', async () => {
    const { graph, beforeRequest, request } = setup();
    beforeRequest.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('paused'));
    await expect(graph.identity()).rejects.toThrow('paused');
    expect(request).not.toHaveBeenCalled();
  });
  test('ambiguous create has no retry and opaque provider details', async () => {
    const { graph, request } = setup();
    request.mockRejectedValue(new Error('token=private-token body=mail-content'));
    await expect(graph.createReply('message', 'Hello')).rejects.toMatchObject({ uncertain: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(new MailGraphError(401).message).not.toContain('private-token');
  });
  test('rejects unsafe mailbox links', () => {
    expect(safeOutlookUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeOutlookUrl('https://outlook.office.com.attacker.test/')).toBeUndefined();
    expect(safeOutlookUrl('https://outlook.office.com/mail/id')).toBe(
      'https://outlook.office.com/mail/id',
    );
  });
});
