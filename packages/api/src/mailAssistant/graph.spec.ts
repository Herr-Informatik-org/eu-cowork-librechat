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
      'attachments',
      'categorize',
      'correspondencePage',
      'createReply',
      'editDraft',
      'editableReply',
      'folder',
      'folders',
      'historyPage',
      'identity',
      'inboxPage',
      'message',
      'move',
      'page',
      'preview',
      'thread',
    ]);
  });
  test.each([
    ['102', 'replied'],
    ['103', 'replied'],
    ['104', 'forwarded'],
  ])('reads the last Outlook action %s in the existing message request', async (verb, expected) => {
    const { graph, request } = setup();
    request.mockResolvedValueOnce(
      response({
        ...row,
        singleValueExtendedProperties: [
          { id: 'Integer 0x1081', value: verb },
          { id: 'SystemTime 0x1082', value: '2026-10-28T09:23:45.1234567Z' },
        ],
      }),
    );
    const actual = await graph.message(row.id);
    expect(actual.responseAction).toBe(expected);
    expect(actual.responseActionAt).toBe('2026-10-28T09:23:45.123Z');
    expect(actual).not.toHaveProperty('singleValueExtendedProperties');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(new URL(url).searchParams.get('$expand')).toBe(
      "singleValueExtendedProperties($filter=id eq 'Integer 0x1081' or id eq 'SystemTime 0x1082')",
    );
  });
  test.each([
    undefined,
    [],
    [{ id: 'Integer 0x1081', value: '0' }],
    [{ id: 'Integer 0x1081', value: '105' }],
    [{ id: 'Integer 0x1081', value: '106' }],
    [{ id: 'Integer 0x1081', value: '0x105' }],
    [{ id: 'Integer 0x1081', value: 102 }],
    [{ id: 'Integer 0x1081', value: '102junk' }],
    [{ id: 'String 0x1081', value: '102' }],
    [
      { id: 'Integer 0x1081', value: '102' },
      { id: 'INTEGER 0X1081', value: '104' },
    ],
    [{ id: 'SystemTime 0x1082', value: '2026-10-28T09:23:45Z' }],
    [null, 'invalid', { id: 'Integer 0x1081', value: '500' }],
  ])('keeps absent, unsupported or ambiguous last verbs unknown: %j', async (properties) => {
    const { graph, request } = setup();
    request.mockResolvedValueOnce(
      response({
        ...row,
        subject: 'AW: WG: RE: FWD: Important mail',
        singleValueExtendedProperties: properties,
      }),
    );
    const actual = await graph.message(row.id);
    expect(actual.responseAction).toBeUndefined();
    expect(actual.responseActionAt).toBeUndefined();
  });
  test.each(['invalid', '2026-02-31T09:23:45Z', '2026-10-28', '2026-10-28T25:23:45Z'])(
    'does not expose invalid action time %s',
    async (time) => {
      const { graph, request } = setup();
      request.mockResolvedValueOnce(
        response({
          ...row,
          singleValueExtendedProperties: [
            { id: 'Integer 0x1081', value: '104' },
            { id: 'SystemTime 0x1082', value: time },
          ],
        }),
      );
      const actual = await graph.message(row.id);
      expect(actual.responseAction).toBe('forwarded');
      expect(actual.responseActionAt).toBeUndefined();
    },
  );
  test('never marks a draft as replied and drops ambiguous action times', async () => {
    const { graph, request } = setup();
    const properties = [
      { id: 'Integer 0x1081', value: '102' },
      { id: 'SystemTime 0x1082', value: '2026-10-28T09:23:45Z' },
      { id: 'SystemTime 0x1082', value: '2026-10-28T10:23:45Z' },
    ];
    request.mockResolvedValueOnce(
      response({ ...row, isDraft: true, singleValueExtendedProperties: properties }),
    );
    expect((await graph.message(row.id)).responseAction).toBeUndefined();
    request.mockResolvedValueOnce(response({ ...row, singleValueExtendedProperties: properties }));
    const actual = await graph.message(row.id);
    expect(actual.responseAction).toBe('replied');
    expect(actual.responseActionAt).toBeUndefined();
  });
  test('attachment listing returns bounded metadata and never reads bytes or follows links', async () => {
    const { graph, request } = setup();
    request.mockResolvedValueOnce(
      response({
        value: [
          {
            id: 'attachment',
            name: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 4300,
            isInline: false,
            contentBytes: 'ignored-payload',
            sourceUrl: 'https://attacker.test/private',
          },
        ],
        '@odata.nextLink': 'https://attacker.test/more',
      }),
    );
    await expect(graph.attachments(row.id)).resolves.toEqual({
      attachments: [
        {
          id: 'attachment',
          name: 'invoice.pdf',
          contentType: 'application/pdf',
          size: 4300,
          isInline: false,
        },
      ],
      hasMore: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/id%2F%2B%3D%3D/attachments?$select=id,name,contentType,size,isInline&$top=100',
    );
    expect(request.mock.calls[0][1].method).toBe('GET');
  });
  test.each([
    { id: '', name: 'x', contentType: 'text/plain', size: 1, isInline: false },
    { id: 'x', name: 'x', contentType: 'text/plain', size: -1, isInline: false },
    { id: 'x', name: 'x', contentType: 'text/plain', size: 1, isInline: 'false' },
    null,
  ])('invalid attachment metadata fails closed without byte reads', async (entry) => {
    const { graph, request } = setup();
    request.mockResolvedValueOnce(response({ value: [entry] }));
    await expect(graph.attachments('mail')).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledTimes(1);
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
  test('ambiguous category PATCH has no retry or provider detail exposure', async () => {
    const { graph, request } = setup();
    request.mockRejectedValue(new Error('token=private-token body=mail-content'));
    await expect(graph.categorize('message', ['Kunde'], 'W/"current"')).rejects.toMatchObject({
      uncertain: true,
    });
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

describe('metadata-only inbox and correspondence pages', () => {
  const row = (folder = 'immutable-inbox') => ({
    id: 'mail-1',
    conversationId: 'thread',
    changeKey: 'v1',
    subject: 'Test subject',
    from: { emailAddress: { address: 'peer@example.invalid', name: 'Peer Name' } },
    replyTo: [{ emailAddress: { address: 'reply@example.invalid', name: 'Reply Name' } }],
    receivedDateTime: '2026-10-27T10:00:00Z',
    parentFolderId: folder,
    categories: [],
    isDraft: false,
    isRead: true,
    hasAttachments: true,
    body: { content: 'Unexpected private body must be discarded' },
  });
  function fixture(pages: unknown[]) {
    const request = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/inbox?$select=id')) return Response.json({ id: 'immutable-inbox' });
      if (url.includes('/sentitems?$select=id')) return Response.json({ id: 'immutable-sent' });
      return Response.json(pages.shift());
    });
    return {
      request,
      graph: createMailGraph({
        fetch: request,
        token: async () => 'test',
        beforeRequest: async () => undefined,
      }),
    };
  }
  test('lists inbox metadata, names and flags, and follows only its exact immutable folder', async () => {
    const next =
      "https://graph.microsoft.com/v1.0/me/mailFolders('immutable-inbox')/messages?$skiptoken=opaque%2Bpage";
    const { graph, request } = fixture([
      { value: [row()], '@odata.nextLink': next },
      { value: [{ ...row(), id: 'mail-2' }] },
    ]);
    const first = await graph.inboxPage!();
    expect(first.messages[0]).toMatchObject({
      body: '',
      senderName: 'Peer Name',
      isRead: true,
      hasAttachments: true,
      replyTo: [{ name: 'Reply Name', address: 'reply@example.invalid' }],
    });
    expect(first.nextUrl).toBe(next);
    expect((await graph.inboxPage!(next)).messages[0].id).toBe('mail-2');
    expect(request).toHaveBeenCalledTimes(3);
    for (const [url, init] of request.mock.calls) {
      expect(init.method).toBe('GET');
      const select = new URL(url).searchParams.get('$select')!;
      expect(select.split(',')).not.toContain('body');
      expect(select.split(',')).not.toContain('uniqueBody');
    }
    expect(new URL(request.mock.calls[2][0]).searchParams.get('$skiptoken')).toBe('opaque+page');
  });
  test('returns reply and forward markers for a whole metadata page without per-message reads', async () => {
    const expand =
      "singleValueExtendedProperties($filter=id eq 'Integer 0x1081' or id eq 'SystemTime 0x1082')";
    const next = `https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?${new URLSearchParams({ $skip: '50', $expand: expand })}`;
    const { graph, request } = fixture([
      {
        value: ['102', '103', '104'].map((verb) => ({
          ...row(),
          id: `mail-${verb}`,
          singleValueExtendedProperties: [{ id: 'Integer 0x1081', value: verb }],
        })),
        '@odata.nextLink': next,
      },
      { value: [row()] },
    ]);
    expect((await graph.inboxPage!()).messages.map((item) => item.responseAction)).toEqual([
      'replied',
      'replied',
      'forwarded',
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect((await graph.inboxPage!(next)).messages[0].responseAction).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
    for (const [url, init] of request.mock.calls.slice(1)) {
      const query = new URL(url).searchParams;
      expect(query.get('$expand')).toBe(expand);
      expect(query.get('$select')?.split(',')).toContain('singleValueExtendedProperties');
      expect(query.get('$select')?.split(',')).not.toContain('body');
      expect(query.get('$select')?.split(',')).not.toContain('uniqueBody');
      expect(init.method).toBe('GET');
    }
  });
  test.each([
    'https://evil.invalid/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50',
    'https://graph.microsoft.com/v1.0/users/other/mailFolders/immutable-inbox/messages?$skip=50',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-sent/messages?$skip=50',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$select=body',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$expand=attachments',
    "https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$expand=singleValueExtendedProperties($filter=id%20eq%20'Integer%200x1081'%20or%20id%20eq%20'String%200x1000')",
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$expand=singleValueExtendedProperties',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$filter=other',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50&$skip=100',
    'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50#other',
  ])('rejects unsafe metadata continuation before following it: %s', async (next) => {
    const { graph, request } = fixture([]);
    await expect(graph.inboxPage!(next)).rejects.toBeInstanceOf(MailGraphError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('rejects out-of-folder response and unsafe server-provided next link', async () => {
    const first = fixture([{ value: [row('different-folder')] }]);
    await expect(first.graph.inboxPage!()).rejects.toBeInstanceOf(MailGraphError);
    const second = fixture([{ value: [row()], '@odata.nextLink': 'https://attacker.invalid' }]);
    await expect(second.graph.inboxPage!()).rejects.toBeInstanceOf(MailGraphError);
    expect(second.request).toHaveBeenCalledTimes(2);
  });
  test('matches exact sender or recipient locally and retains continuation on an empty search page', async () => {
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/immutable-inbox/messages?$skip=50';
    const { graph, request } = fixture([
      {
        value: [
          row(),
          { ...row(), from: { emailAddress: { address: 'notpeer@example.invalid' } } },
        ],
        '@odata.nextLink': next,
      },
      {
        value: [
          {
            ...row('immutable-sent'),
            from: { emailAddress: { address: 'self@example.invalid' } },
            toRecipients: [{ emailAddress: { address: 'PEER@example.invalid' } }],
          },
          {
            ...row('immutable-sent'),
            isDraft: true,
            toRecipients: [{ emailAddress: { address: 'peer@example.invalid' } }],
          },
        ],
      },
    ]);
    expect(await graph.correspondencePage!('peer@example.invalid', 'inbox', 'absent')).toEqual({
      messages: [],
      nextUrl: next,
      hasMore: true,
    });
    const sent = await graph.correspondencePage!('peer@example.invalid', 'sentitems', 'subject');
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]).toMatchObject({ sentByUser: true, body: '' });
    for (const [url] of request.mock.calls)
      expect(url).not.toMatch(/\$filter|\$search|peer|absent/);
  });
});
