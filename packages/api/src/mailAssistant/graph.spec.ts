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
