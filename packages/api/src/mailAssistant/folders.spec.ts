import { createMailGraph } from './graph';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const folder = {
  id: 'done',
  displayName: '00_erledigt',
  parentFolderId: 'system-inbox',
  childFolderCount: 0,
  isHidden: false,
};
const mail = {
  id: 'message',
  conversationId: 'conversation',
  changeKey: 'key',
  receivedDateTime: '2026-10-27T08:00:00Z',
  categories: ['KI: Wichtig'],
  isDraft: false,
  parentFolderId: 'system-inbox',
  '@odata.etag': 'W/"current"',
};

function setup() {
  const beforeRequest = jest.fn().mockResolvedValue(undefined);
  const token = jest.fn().mockResolvedValue('secret-token');
  const implementation = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      /\/mailFolders\/(inbox|deleteditems|drafts|sentitems|junkemail|outbox|msgfolderroot)$/.test(
        url.pathname,
      ) &&
      url.searchParams.get('$select') === 'id'
    )
      return response({ id: `system-${url.pathname.slice(url.pathname.lastIndexOf('/') + 1)}` });
    if (url.pathname === '/v1.0/me/mailFolders' || url.pathname.endsWith('/childFolders'))
      return response({
        value: [
          { ...folder, id: 'system-inbox', displayName: 'Posteingang', childFolderCount: 1 },
          folder,
          { ...folder, id: 'hidden', isHidden: true },
          { ...folder, id: 'search', '@odata.type': '#microsoft.graph.mailSearchFolder' },
        ],
      });
    if (url.pathname === '/v1.0/me/mailFolders/system-inbox')
      return response({
        id: 'system-inbox',
        parentFolderId: 'system-msgfolderroot',
        isHidden: false,
      });
    if (url.pathname === '/v1.0/me/mailFolders/done') return response(folder);
    if (url.pathname === '/v1.0/me/mailFolders/system-deleteditems')
      return response({ ...folder, id: 'system-deleteditems' });
    if (url.pathname === '/v1.0/me/messages/message') return response(mail);
    if (url.pathname === '/v1.0/me/messages/message/move' && init?.method === 'POST')
      return response({ ...mail, parentFolderId: 'done' }, 201);
    throw Error('Unexpected fixture request');
  };
  const request = jest.fn(implementation);
  return {
    graph: createMailGraph({ fetch: request, token, beforeRequest }),
    request,
    implementation,
    beforeRequest,
  };
}

describe('own folder navigation and deliberate move', () => {
  test('system folder discovery uses at most three concurrent guarded reads and reuses their identities', async () => {
    const state = setup();
    let active = 0;
    let maximum = 0;
    let discoveries = 0;
    state.request.mockImplementation(async (url, init) => {
      if (String(url).endsWith('?$select=id')) {
        discoveries++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      }
      return state.implementation(url, init);
    });
    await state.graph.folders();
    await state.graph.folder('done');
    expect(maximum).toBe(3);
    expect(discoveries).toBe(7);
    expect(state.beforeRequest).toHaveBeenCalledTimes(state.request.mock.calls.length * 2);
  });
  test('lists own visible folders, keeps inbox navigable but not selectable as destination', async () => {
    const { graph, request } = setup();
    expect(await graph.folders()).toEqual([
      expect.objectContaining({ id: 'system-inbox', childFolderCount: 1, canMoveTo: false }),
      expect.objectContaining({ id: 'done', displayName: '00_erledigt', canMoveTo: true }),
    ]);
    await graph.folders('system-inbox');
    expect(request.mock.calls[request.mock.calls.length - 1]?.[0]).toContain(
      '/me/mailFolders/system-inbox/childFolders',
    );
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  test('resolves destination from own mailbox and preserves immutable id and categories', async () => {
    const { graph, request } = setup();
    expect(await graph.move('message', 'done', 'W/"current"')).toMatchObject({
      id: 'message',
      conversationId: 'conversation',
      parentFolderId: 'done',
      categories: ['KI: Wichtig'],
    });
    const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('https://graph.microsoft.com/v1.0/me/messages/message/move');
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ destinationId: 'done' });
    expect(writes[0][1]?.headers).toMatchObject({ 'If-Match': 'W/"current"' });
    expect((writes[0][1]?.headers as Record<string, string>).Prefer).toContain('ImmutableId');
  });
  test.each([
    'deleteditems',
    'drafts',
    'junkemail',
    'outbox',
    'sentitems',
    'inbox',
    'system-deleteditems',
  ])('blocks reserved destination %s even when submitted directly', async (value) => {
    const { graph, request } = setup();
    await expect(graph.move('message', value, 'W/"current"')).rejects.toThrow();
    expect(request.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  test('rejects an employee-modified source before moving', async () => {
    const { graph, request } = setup();
    await expect(graph.move('message', 'done', 'W/"old"')).rejects.toMatchObject({ status: 409 });
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  test('does not permit a custom destination nested below deleted items', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1.0/me/mailFolders/done')
        return response({ ...folder, parentFolderId: 'nested' });
      if (path === '/v1.0/me/mailFolders/nested')
        return response({ id: 'nested', parentFolderId: 'system-deleteditems' });
      return state.implementation(url, init);
    });
    await expect(state.graph.move('message', 'done', 'W/"current"')).rejects.toMatchObject({
      status: 400,
    });
    expect(state.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  test('rejects cyclic or unprovable folder ancestry', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      new URL(String(url)).pathname === '/v1.0/me/mailFolders/done'
        ? response({ ...folder, parentFolderId: 'done' })
        : state.implementation(url, init),
    );
    await expect(state.graph.folder('done')).rejects.toMatchObject({ status: 400 });
  });
  test('an already moved source is idempotent without a second POST', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      String(url).includes('/messages/message?')
        ? response({ ...mail, parentFolderId: 'done' })
        : state.implementation(url, init),
    );
    await state.graph.move('message', 'done', 'W/"current"');
    expect(state.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  test('uncertain move has no retry and no private error detail', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      String(url).endsWith('/move')
        ? Promise.reject(Error('secret-token private-subject'))
        : state.implementation(url, init),
    );
    await expect(state.graph.move('message', 'done', 'W/"current"')).rejects.toMatchObject({
      uncertain: true,
    });
    expect(state.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  test('does not claim success when Graph returns a different destination or immutable id', async () => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      String(url).endsWith('/move')
        ? response({ ...mail, id: 'other', parentFolderId: 'done' }, 201)
        : state.implementation(url, init),
    );
    await expect(state.graph.move('message', 'done', 'W/"current"')).rejects.toMatchObject({
      uncertain: true,
    });
  });
  test.each([
    'https://attacker.test/v1.0/me/mailFolders?$skip=100',
    'https://graph.microsoft.com/v1.0/users/another/mailFolders?$skip=100',
    'https://graph.microsoft.com/v1.0/me/mailFolders/other/childFolders?$skip=100',
    'https://graph.microsoft.com/v1.0/me/mailFolders/../mailFolders?$skip=100',
    'https://user:secret@graph.microsoft.com/v1.0/me/mailFolders?$skip=100',
  ])('rejects an injected folder page URL %s', async (link) => {
    const state = setup();
    state.request.mockImplementation(async (url, init) =>
      new URL(String(url)).pathname === '/v1.0/me/mailFolders'
        ? response({ value: [], '@odata.nextLink': link })
        : state.implementation(url, init),
    );
    await expect(state.graph.folders()).rejects.toThrow();
    expect(state.request.mock.calls.filter(([url]) => String(url) === link)).toHaveLength(0);
  });
  test('follows own collection pagination without silently losing later folders', async () => {
    const state = setup();
    const next = 'https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=opaque';
    state.request.mockImplementation(async (url, init) =>
      new URL(String(url)).pathname === '/v1.0/me/mailFolders'
        ? response(
            String(url) === next ? { value: [folder] } : { value: [], '@odata.nextLink': next },
          )
        : state.implementation(url, init),
    );
    expect(await state.graph.folders()).toEqual([expect.objectContaining({ id: 'done' })]);
    expect(state.request.mock.calls[state.request.mock.calls.length - 1]?.[0]).toBe(next);
  });
  test.each(['.', '..', 'line\nfeed', 'slash\\path'])(
    'cannot use path control as a message id %s',
    async (value) => {
      const { graph, request } = setup();
      await expect(graph.message(value)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
});
