import { createMailInbox } from './inbox';
import { createMailCodec } from './privateData';
import { defaultMailSettings } from './schedule';
import type { MailMessage, MailRuntimeAdapter, MailStore, StoredMailResult } from './types';

const mail = (id = 'message-1'): MailMessage => ({
  id,
  conversationId: 'shared-conversation',
  changeKey: 'v1',
  subject: 'Private subject',
  sender: 'peer@example.invalid',
  receivedAt: '2026-10-27T10:00:00Z',
  body: '',
  categories: [],
  isDraft: false,
  isRead: false,
  hasAttachments: true,
});
function setup() {
  const codec = createMailCodec('ab'.repeat(32));
  let clock = new Date('2026-10-27T11:00:00Z');
  let generation = 'connection-1';
  let revision = 1;
  let consent = '2026-10-27';
  const rows = new Map<string, StoredMailResult>();
  const store = {
    read: jest.fn(async () => ({
      ownerId: 'alice',
      revision,
      settings: { ...defaultMailSettings(), consentVersion: consent },
    })),
    results: jest.fn(async () => [...rows.values()]),
    result: jest.fn(async (_owner: string, id: string) => rows.get(id) ?? null),
    seedResults: jest.fn(async (_owner: string, values: StoredMailResult[]) =>
      values.map((value) => {
        if (!rows.has(value.id)) rows.set(value.id, structuredClone(value));
        return rows.get(value.id)!;
      }),
    ),
  } as unknown as MailStore;
  const graph = {
    inboxPage: jest
      .fn()
      .mockResolvedValue({ messages: [mail(), mail('message-2')], hasMore: false }),
    correspondencePage: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
  };
  const adapter = {
    authorize: jest.fn(async () => undefined),
    connection: jest.fn(async () => ({
      connected: true,
      mailbox: 'self@example.invalid',
      generation,
    })),
    graph: jest.fn(async () => graph),
    analyze: jest.fn(),
    analyzeDraft: jest.fn(),
    audit: jest.fn(),
  } as unknown as MailRuntimeAdapter;
  return {
    store,
    graph,
    adapter,
    rows,
    codec,
    advance: () => {
      clock = new Date(clock.getTime() + 11 * 60_000);
    },
    reconnect: () => {
      generation = 'new-connection';
    },
    revoke: () => {
      consent = '';
      revision++;
    },
    revise: () => {
      revision++;
    },
    service: createMailInbox({ store, adapter, codec, now: () => clock }),
  };
}

describe('owner-bound complete inbox metadata view', () => {
  test('exposes every message in one conversation with distinct stable IDs and no analysis or writes', async () => {
    const f = setup();
    const first = await f.service.inbox('alice');
    expect(first.complete).toBe(true);
    expect(first.results).toHaveLength(2);
    expect(first.results[0].id).not.toBe(first.results[1].id);
    expect(first.results[0]).toMatchObject({
      analysisStatus: 'pending',
      draftStatus: 'none',
      mailboxLocation: 'inbox',
      hasAttachments: true,
    });
    expect(first.results[0]).not.toHaveProperty('messageId');
    expect(first.results[0]).not.toHaveProperty('connectionGeneration');
    expect(first.results[0]).not.toHaveProperty('sourceHash');
    expect((await f.service.inbox('alice')).results.map((value) => value.id)).toEqual(
      first.results.map((value) => value.id),
    );
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
  });
  test('reuses an exact historical analysis ID and never copies another message in its conversation', async () => {
    const f = setup();
    await f.service.inbox('alice');
    const original = [...f.rows.values()][0];
    f.rows.delete(original.id);
    f.rows.set('a'.repeat(64), {
      ...original,
      id: 'a'.repeat(64),
      analysisStatus: 'complete',
      summary: 'Already analysed',
      draftStatus: 'created',
      draftId: 'existing-draft',
    });
    const listed = await f.service.inbox('alice');
    expect(listed.results[0]).toMatchObject({
      id: 'a'.repeat(64),
      analysisStatus: 'complete',
      summary: 'Already analysed',
      draftStatus: 'created',
    });
    expect(listed.results[1]).toMatchObject({
      analysisStatus: 'pending',
      summary: '',
      draftStatus: 'none',
    });
    expect(f.rows.size).toBe(2);
  });
  test('encrypted cursor follows metadata and is bound to owner, scope, generation and expiry', async () => {
    const f = setup();
    const link = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50';
    f.graph.inboxPage.mockResolvedValueOnce({ messages: [mail()], nextUrl: link, hasMore: true });
    const first = await f.service.inbox('alice');
    expect(first.nextCursor).not.toContain('graph.microsoft');
    await f.service.inbox('alice', first.nextCursor);
    expect(f.graph.inboxPage).toHaveBeenLastCalledWith(link);
    await expect(f.service.inbox('bob', first.nextCursor)).rejects.toThrow('abgelaufen');
    await expect(
      f.service.correspondence('alice', first.results[0].id, { cursor: first.nextCursor }),
    ).rejects.toThrow('abgelaufen');
    f.reconnect();
    await expect(f.service.inbox('alice', first.nextCursor)).rejects.toThrow('abgelaufen');
    const expiry = setup();
    expiry.graph.inboxPage.mockResolvedValueOnce({ messages: [], nextUrl: link, hasMore: true });
    const pending = await expiry.service.inbox('alice');
    expiry.advance();
    await expect(expiry.service.inbox('alice', pending.nextCursor)).rejects.toThrow('abgelaufen');
  });
  test('connection replacement during a page read cannot seed or expose the page', async () => {
    const f = setup();
    f.graph.inboxPage.mockImplementationOnce(async () => {
      f.reconnect();
      return { messages: [mail()], hasMore: false };
    });
    await expect(f.service.inbox('alice')).rejects.toThrow('geändert');
    expect(f.store.seedResults).not.toHaveBeenCalled();
  });
  test('requires current consent, fences settings changes and fails closed on audit errors', async () => {
    const revoked = setup();
    revoked.revoke();
    await expect(revoked.service.inbox('alice')).rejects.toThrow('bestätigen');
    expect(revoked.graph.inboxPage).not.toHaveBeenCalled();
    const audit = setup();
    (audit.adapter.audit as jest.Mock).mockRejectedValueOnce(Error('audit unavailable'));
    await expect(audit.service.inbox('alice')).rejects.toThrow('audit unavailable');
    expect(audit.graph.inboxPage).not.toHaveBeenCalled();
    const changed = setup();
    changed.graph.inboxPage.mockImplementationOnce(async () => {
      changed.revise();
      return { messages: [mail()], hasMore: false };
    });
    await expect(changed.service.inbox('alice')).rejects.toThrow('geändert');
    expect(changed.store.seedResults).not.toHaveBeenCalled();
  });
  test('reconnect does not silently enable old-generation metadata', async () => {
    const f = setup();
    await f.service.inbox('alice');
    f.reconnect();
    await expect(f.service.inbox('alice')).rejects.toThrow('früheren Verbindung');
  });
  test('correspondence carries exact peer and search through empty pages into sent mail', async () => {
    const f = setup();
    const source = (await f.service.inbox('alice')).results[0].id;
    f.graph.correspondencePage.mockResolvedValue({
      messages: [],
      hasMore: true,
      nextUrl: 'next-1',
    });
    let pageIndex = 0;
    f.graph.correspondencePage.mockImplementation(async () => ({
      messages: [],
      hasMore: true,
      nextUrl: `page-${++pageIndex}`,
    }));
    const first = await f.service.correspondence('alice', source, { search: 'Topic' });
    expect(first).toMatchObject({ results: [], complete: false });
    expect(f.graph.correspondencePage).toHaveBeenLastCalledWith(
      'peer@example.invalid',
      'inbox',
      'Topic',
      'page-4',
    );
    expect(f.graph.correspondencePage).toHaveBeenCalledTimes(5);
    await expect(
      f.service.correspondence('alice', source, { search: 'Different', cursor: first.nextCursor }),
    ).rejects.toThrow('abgelaufen');
    f.graph.correspondencePage.mockResolvedValueOnce({ messages: [], hasMore: false });
    f.graph.correspondencePage.mockResolvedValueOnce({
      messages: [{ ...mail('outgoing'), sender: 'self@example.invalid', sentByUser: true }],
      hasMore: false,
    });
    const sent = await f.service.correspondence('alice', source, {
      search: 'Topic',
      cursor: first.nextCursor,
    });
    expect(sent.complete).toBe(true);
    expect(sent.results[0].mailboxLocation).toBe('sent');
    const sentRecord = f.rows.get(sent.results[0].id)!;
    expect(sentRecord.correspondent).toBe('peer@example.invalid');
    expect(sent.results[0]).not.toHaveProperty('correspondent');
    f.graph.correspondencePage.mockResolvedValueOnce({ messages: [mail()], hasMore: false });
    await f.service.correspondence('alice', sent.results[0].id, {});
    expect(f.graph.correspondencePage).toHaveBeenLastCalledWith(
      'peer@example.invalid',
      'inbox',
      '',
      undefined,
    );
  });
  test('does not follow repeated pages and rechecks authorization before returning metadata', async () => {
    const f = setup();
    const nextUrl = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50';
    f.graph.inboxPage.mockResolvedValue({ messages: [], hasMore: true, nextUrl });
    const first = await f.service.inbox('alice');
    await expect(f.service.inbox('alice', first.nextCursor)).rejects.toThrow(
      'gültige nächste Seite',
    );
    (f.adapter.authorize as jest.Mock).mockRejectedValueOnce(Error('revoked'));
    await expect(f.service.inbox('alice')).rejects.toThrow('revoked');
  });
});
