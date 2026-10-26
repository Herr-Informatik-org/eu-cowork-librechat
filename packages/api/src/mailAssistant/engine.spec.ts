import { createHash } from 'node:crypto';
import { createMailAssistantEngine } from './engine';
import { createMailGraph, MailGraphError } from './graph';
import { defaultMailSettings } from './schedule';
import type {
  MailJob,
  MailStore,
  StoredMailResult,
  MailMessage,
  MailRuntimeAdapter,
  MailAnalysis,
} from './types';

function fixture() {
  const owner = 'alice';
  let instant = new Date('2026-10-26T08:00:00Z');
  const jobs = new Map<string, MailJob>([
    [
      owner,
      {
        ownerId: owner,
        revision: 1,
        enabledAt: '2026-10-26T07:00:00Z',
        settings: {
          ...defaultMailSettings(),
          enabled: true,
          mode: 'scheduled',
          consentVersion: '2026-10-25',
        },
      },
    ],
  ]);
  const results = new Map<string, StoredMailResult>();
  const operations = new Map<
    string,
    { sourceHash: string; state: 'pending' | 'completed' | 'failed' }
  >();
  const message: MailMessage = {
    id: 'mail',
    conversationId: 'conversation',
    changeKey: 'version',
    subject: 'Support',
    sender: 'customer@example.invalid',
    receivedAt: '2026-10-26T07:30:00Z',
    body: 'Bitte senden Sie die Anleitung.',
    etag: 'W/"version"',
    categories: ['Kunde'],
    isDraft: false,
  };
  const copy = <T>(value: T): T => structuredClone(value);
  const store: MailStore = {
    draftState: async (id, key) => operations.get(id + ':' + key) ?? null,
    reserveDraft: async (id, _token, key, sourceHash) => {
      const old = operations.get(id + ':' + key);
      if (old?.state === 'pending' || old?.sourceHash === sourceHash) return false;
      operations.set(id + ':' + key, { sourceHash, state: 'pending' });
      return true;
    },
    finishDraft: async (id, key, sourceHash, state) => {
      if (operations.get(id + ':' + key)?.sourceHash === sourceHash)
        operations.set(id + ':' + key, { sourceHash, state });
    },
    read: jest.fn(async (id) => (jobs.has(id) ? copy(jobs.get(id)!) : null)),
    saveSettings: jest.fn(async (id, settings) => {
      jobs.get(id)!.settings = settings;
      jobs.get(id)!.revision++;
      delete jobs.get(id)!.leaseToken;
      delete jobs.get(id)!.leaseUntil;
    }),
    pause: jest.fn(async (id) => {
      jobs.get(id)!.settings.enabled = false;
      jobs.get(id)!.revision++;
      delete jobs.get(id)!.leaseToken;
      delete jobs.get(id)!.leaseUntil;
    }),
    purge: jest.fn(async (id) => {
      jobs.delete(id);
      for (const key of results.keys()) if (key.startsWith(id + ':')) results.delete(key);
    }),
    due: jest.fn(async () => [...jobs.keys()]),
    prune: jest.fn(async () => {}),
    claim: jest.fn(async (id, token, now) => {
      const job = jobs.get(id);
      if (!job?.settings.enabled || (job.leaseUntil && job.leaseUntil > now)) return null;
      job.leaseToken = token;
      job.leaseUntil = new Date(now.getTime() + 120000);
      return copy(job);
    }),
    update: jest.fn(async (id, token, fields) => {
      if (jobs.get(id)?.leaseToken !== token || !jobs.get(id)?.settings.enabled) return false;
      Object.assign(jobs.get(id)!, copy(fields));
      return true;
    }),
    release: jest.fn(async (id, token, fields) => {
      const job = jobs.get(id);
      if (!job || job.leaseToken !== token) return;
      Object.assign(job, copy(fields));
      delete job.leaseToken;
      delete job.leaseUntil;
    }),
    results: jest.fn(async (id) =>
      [...results].filter(([key]) => key.startsWith(id + ':')).map(([, value]) => copy(value)),
    ),
    result: jest.fn(async (id, key) =>
      results.has(id + ':' + key) ? copy(results.get(id + ':' + key)!) : null,
    ),
    putResult: jest.fn(async (id, token, result) => {
      if (jobs.get(id)?.leaseToken !== token || !jobs.get(id)?.settings.enabled)
        throw Error('lost lease');
      results.set(id + ':' + result.id, copy(result));
    }),
  };
  let guard = async () => {};
  const graph = {
    identity: jest.fn(async () => ({
      id: 'own-ms-id',
      mail: 'alice@example.invalid',
      userPrincipalName: 'alice@example.invalid',
    })),
    page: jest.fn(async () => {
      await guard();
      return { messages: [copy(message)], nextUrl: 'cursor', hasMore: false };
    }),
    historyPage: jest.fn(
      async (): Promise<{ messages: MailMessage[]; nextUrl?: string; hasMore: boolean }> => {
        await guard();
        return { messages: [copy(message)], hasMore: false };
      },
    ),
    message: jest.fn(async (_id: string) => {
      await guard();
      return copy(message);
    }),
    thread: jest.fn(async (_conversation: string) => {
      await guard();
      return { messages: [copy(message)], complete: true };
    }),
    categorize: jest.fn(async (_id, categories) => {
      await guard();
      message.categories = categories;
    }),
    createReply: jest.fn(async (_id: string, _text: string) => {
      await guard();
      return { id: 'draft-id', url: 'https://outlook.office.com/mail/draft' };
    }),
  };
  const adapter: MailRuntimeAdapter = {
    authorize: jest.fn(async (id) => {
      if (!jobs.has(id)) throw Error('No account');
    }),
    availability: jest.fn(async () => ({
      available: true,
      modelLabel: 'Default · approved',
      modelFingerprint: 'a'.repeat(64),
    })),
    connection: jest.fn(async () => ({
      connected: true,
      mailbox: 'alice@example.invalid',
      generation: 'connection-v1',
    })),
    graph: jest.fn(async (_id, before) => {
      guard = before;
      return graph;
    }),
    analyze: jest.fn(
      async (): Promise<MailAnalysis> => ({
        priority: 'normal',
        action: 'reply',
        summary: 'Kunde benötigt Anleitung.',
        reason: 'Gewöhnliche Anfrage.',
        questions: ['Welche Version?'],
        draft: 'Guten Tag\n\nGerne unterstützen wir Sie.',
      }),
    ),
    audit: jest.fn(async () => {}),
  };
  const engine = createMailAssistantEngine({ store, adapter, now: () => instant });
  return {
    engine,
    owner,
    jobs,
    results,
    operations,
    store,
    graph,
    adapter,
    message,
    now: (value: string) => {
      instant = new Date(value);
    },
  };
}

describe('mail assistant deterministic safety boundary', () => {
  function historyFixture() {
    const f = fixture();
    const job = f.jobs.get(f.owner)!;
    job.settings.history = { mode: 'all' };
    job.history = {
      until: job.enabledAt!,
      pending: [],
      processed: 0,
      completed: false,
      hasMore: true,
    };
    f.message.receivedAt = '2026-10-25T07:30:00Z';
    f.graph.page.mockResolvedValue({ messages: [], nextUrl: 'live-cursor', hasMore: false });
    return f;
  }
  function backloggedFixture() {
    const f = historyFixture();
    const messages = new Map<string, MailMessage>();
    for (const stream of ['history', 'live']) {
      for (let i = 0; i < 20; i++) {
        const id = `${stream}-${i}`;
        messages.set(id, {
          ...f.message,
          id,
          conversationId: id,
          receivedAt: stream === 'history' ? '2026-10-25T07:30:00Z' : '2026-10-26T07:30:00Z',
        });
      }
    }
    f.graph.historyPage.mockResolvedValue({
      messages: [...messages.values()].filter((mail) => mail.id.startsWith('history-')),
      hasMore: false,
    });
    f.graph.page.mockResolvedValue({
      messages: [...messages.values()].filter((mail) => mail.id.startsWith('live-')),
      nextUrl: 'live-cursor',
      hasMore: false,
    });
    const message = f.graph.message.getMockImplementation()!;
    f.graph.message.mockImplementation(async (id) => {
      await message(id);
      return structuredClone(messages.get(id)!);
    });
    const thread = f.graph.thread.getMockImplementation()!;
    f.graph.thread.mockImplementation(async (id) => {
      await thread(id);
      return { messages: [structuredClone(messages.get(id)!)], complete: true };
    });
    (f.adapter.analyze as jest.Mock).mockResolvedValue({
      priority: 'normal',
      action: 'information',
      summary: 'Info',
      reason: 'Grund',
      questions: [],
      draft: '',
    });
    return f;
  }
  test('live and historical backlogs share the twenty-message limit without losing either cursor', async () => {
    const f = backloggedFixture();
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(20);
    expect(f.jobs.get(f.owner)!.history).toMatchObject({ processed: 10, completed: false });
    expect(f.jobs.get(f.owner)!.history!.pending).toHaveLength(10);
    expect(f.jobs.get(f.owner)!.checkpoint!.pending).toHaveLength(10);
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(40);
    expect(f.jobs.get(f.owner)!.history).toMatchObject({ processed: 20, completed: true });
    expect(f.jobs.get(f.owner)!.checkpoint).toMatchObject({ pending: [], url: 'live-cursor' });
    expect(f.graph.historyPage).toHaveBeenCalledTimes(1);
    expect(f.graph.page).toHaveBeenCalledTimes(1);
  });
  test('slow model calls alternate priority durably so neither backlog starves across runs', async () => {
    const f = backloggedFixture();
    let clock = Date.parse('2026-10-26T08:00:00Z');
    const analyze = f.adapter.analyze;
    f.adapter.analyze = jest.fn(async (...args) => {
      const result = await analyze(...args);
      clock += 60_000;
      f.now(new Date(clock).toISOString());
      return result;
    });
    await f.engine.run(f.owner);
    expect(f.jobs.get(f.owner)!.history).toMatchObject({ processed: 4, nextFirst: 'live' });
    expect(f.graph.page).not.toHaveBeenCalled();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(4);
    await f.engine.run(f.owner);
    expect(f.jobs.get(f.owner)!.history).toMatchObject({ processed: 4, nextFirst: 'history' });
    expect(f.jobs.get(f.owner)!.checkpoint!.pending).toHaveLength(16);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(8);
    await f.engine.run(f.owner);
    expect(f.jobs.get(f.owner)!.history).toMatchObject({ processed: 8, nextFirst: 'live' });
    expect(f.jobs.get(f.owner)!.checkpoint!.pending).toHaveLength(16);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(12);
    expect(f.graph.historyPage).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('history is opt-in and old live-page metadata never triggers body reads', async () => {
    const f = fixture();
    f.message.receivedAt = '2026-10-25T07:30:00Z';
    await f.engine.run(f.owner);
    expect(f.graph.message).not.toHaveBeenCalled();
    expect(f.graph.historyPage).not.toHaveBeenCalled();
    expect((await f.engine.status(f.owner)).activity.history).toMatchObject({
      mode: 'off',
      hasMore: false,
    });
  });
  test('historical entries use the same own-mail draft boundary and never restart after completion', async () => {
    const f = historyFixture();
    await f.engine.run(f.owner);
    const status = await f.engine.status(f.owner);
    expect(status.activity.history).toMatchObject({
      processed: 1,
      completed: true,
      hasMore: false,
      until: f.jobs.get(f.owner)!.enabledAt,
    });
    expect(status.results).toHaveLength(1);
    expect(f.graph.historyPage).toHaveBeenCalledWith(undefined, '2026-10-26T07:00:00Z', undefined);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    await f.engine.run(f.owner);
    expect(f.graph.historyPage).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect(f.jobs.get(f.owner)!.checkpoint?.url).toBe('live-cursor');
  });
  test('empty historical pages still report more work and resume at their own cursor', async () => {
    const f = historyFixture();
    f.graph.historyPage.mockResolvedValueOnce({
      messages: [],
      nextUrl: 'history-next',
      hasMore: true,
    });
    await f.engine.run(f.owner);
    expect((await f.engine.status(f.owner)).activity.history).toMatchObject({
      processed: 0,
      pending: 0,
      hasMore: true,
      completed: false,
    });
    await f.engine.run(f.owner);
    expect(f.graph.historyPage).toHaveBeenLastCalledWith(
      undefined,
      '2026-10-26T07:00:00Z',
      'history-next',
    );
    expect((await f.engine.status(f.owner)).activity.history.completed).toBe(true);
  });
  test('live next pages are distinguished from a completed delta round', async () => {
    const f = fixture();
    f.graph.page
      .mockResolvedValueOnce({ messages: [], nextUrl: 'next-page', hasMore: true })
      .mockResolvedValueOnce({ messages: [], nextUrl: 'delta-token', hasMore: false });
    await f.engine.run(f.owner);
    expect((await f.engine.status(f.owner)).activity).toMatchObject({ pending: 0, hasMore: true });
    await f.engine.run(f.owner);
    expect((await f.engine.status(f.owner)).activity).toMatchObject({ pending: 0, hasMore: false });
    f.jobs.get(f.owner)!.checkpoint = { pending: [], url: 'legacy-cursor' };
    expect((await f.engine.status(f.owner)).activity.hasMore).toBe(true);
  });
  test('historical metadata outside the frozen range is discarded before body reads', async () => {
    const f = historyFixture();
    const job = f.jobs.get(f.owner)!;
    job.settings.history = { mode: 'since', from: '2026-10-24' };
    job.history!.from = '2026-10-23T22:00:00.000Z';
    f.graph.historyPage.mockResolvedValue({
      messages: [
        { ...f.message, receivedAt: '2026-10-23T21:59:59Z' },
        { ...f.message, id: 'newer', receivedAt: job.enabledAt! },
        { ...f.message, id: 'draft', isDraft: true },
      ],
      hasMore: false,
    });
    await f.engine.run(f.owner);
    expect(f.graph.message).not.toHaveBeenCalled();
    expect(f.adapter.analyze).not.toHaveBeenCalled();
  });
  test.each(['pause', 'settings', 'disconnect'] as const)(
    'historical processing stops after %s before a body read',
    async (action) => {
      const f = historyFixture();
      f.graph.historyPage.mockImplementation(async () => {
        if (action === 'pause') await f.engine.pause(f.owner);
        else if (action === 'disconnect') await f.engine.disconnect(f.owner);
        else
          await f.store.saveSettings(
            f.owner,
            { ...f.jobs.get(f.owner)!.settings, history: { mode: 'off' } },
            new Date(),
          );
        return { messages: [f.message], hasMore: false };
      });
      await f.engine.run(f.owner);
      expect(f.graph.message).not.toHaveBeenCalled();
      expect(f.adapter.analyze).not.toHaveBeenCalled();
      expect(f.graph.categorize).not.toHaveBeenCalled();
    },
  );
  test('historical model completion cannot write after a settings revision', async () => {
    const f = historyFixture();
    const analyze = f.adapter.analyze;
    f.adapter.analyze = async (...args) => {
      const result = await analyze(...args);
      await f.store.saveSettings(
        f.owner,
        { ...f.jobs.get(f.owner)!.settings, history: { mode: 'off' } },
        new Date(),
      );
      return result;
    };
    await f.engine.run(f.owner);
    expect(f.graph.categorize).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('historical processing preserves human drafts and account boundaries', async () => {
    const f = historyFixture();
    f.graph.thread.mockResolvedValue({
      complete: true,
      messages: [f.message, { ...f.message, id: 'draft', isDraft: true }],
    });
    await expect(f.engine.run('other-user')).rejects.toThrow();
    expect(f.graph.historyPage).not.toHaveBeenCalled();
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect((await f.engine.status(f.owner)).results[0].draftStatus).toBe('existing');
  });
  test('historical range changes can rescan without duplicating completed draft operations', async () => {
    const f = historyFixture();
    await f.engine.run(f.owner);
    f.results.clear();
    f.jobs.get(f.owner)!.history = {
      until: f.jobs.get(f.owner)!.enabledAt!,
      pending: [],
      processed: 0,
      completed: false,
      hasMore: true,
    };
    await f.engine.run(f.owner);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
  test('creates a reply draft and keeps existing categories, questions only in overview', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    expect(f.graph.categorize).toHaveBeenCalledWith('mail', ['Kunde', 'KI: Normal'], 'W/"version"');
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply.mock.calls[0][1]).not.toContain('Welche Version');
    const status = await f.engine.status(f.owner);
    expect(status.results[0]).toMatchObject({
      draftStatus: 'created',
      questions: ['Welche Version?'],
    });
    expect(status.results[0]).not.toHaveProperty('messageId');
    expect(status.results[0]).not.toHaveProperty('sourceHash');
    expect(status.results[0]).not.toHaveProperty('draft');
    expect(JSON.stringify([...f.results.values()])).not.toContain(f.message.body);
    expect(JSON.stringify(f.jobs.get(f.owner)?.checkpoint)).not.toContain(f.message.body);
  });
  test('ordinary delta echoes never analyze or create twice', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
  test('records manual Outlook category changes without reclassification', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    f.message.categories = ['Kunde', 'KI: Wichtig'];
    await f.engine.run(f.owner);
    expect((await f.engine.status(f.owner)).results[0]).toMatchObject({
      priority: 'important',
      manualPriority: true,
    });
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.graph.categorize).toHaveBeenCalledTimes(1);
  });
  test.each(['information', 'review'] as const)('never drafts for action %s', async (action) => {
    const f = fixture();
    (f.adapter.analyze as jest.Mock).mockResolvedValue({
      priority: 'important',
      action,
      summary: 'Info',
      reason: 'Grund',
      questions: [],
      draft: 'must not create',
    });
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('low priority never drafts, even if model says reply', async () => {
    const f = fixture();
    (f.adapter.analyze as jest.Mock).mockResolvedValue({
      priority: 'low',
      action: 'reply',
      summary: 'Werbung',
      reason: 'Newsletter',
      questions: [],
      draft: 'do not use',
    });
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('existing human draft is neither replaced nor duplicated', async () => {
    const f = fixture();
    f.graph.thread.mockImplementation(async () => ({
      complete: true,
      messages: [
        f.message,
        { ...f.message, id: 'human-draft', isDraft: true, body: 'Private correction' },
      ],
    }));
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect((await f.engine.status(f.owner)).results[0].draftStatus).toBe('existing');
  });
  test('human response while model runs prevents a draft', async () => {
    const f = fixture();
    f.graph.thread
      .mockResolvedValueOnce({ complete: true, messages: [f.message] })
      .mockResolvedValue({
        complete: true,
        messages: [
          f.message,
          { ...f.message, id: 'sent', sentByUser: true, sentAt: '2026-10-26T07:59:00Z' },
        ],
      });
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('unknown POST outcome is persisted and never automatically repeated', async () => {
    const f = fixture();
    f.graph.createReply.mockRejectedValue(new MailGraphError(0, true));
    await f.engine.run(f.owner);
    await f.engine.run(f.owner);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect((await f.engine.status(f.owner)).results[0].draftStatus).toBe('uncertain');
  });
  test('unknown POST barrier survives result expiry and still allows new summaries', async () => {
    const f = fixture();
    f.graph.createReply.mockRejectedValue(new MailGraphError(0, true));
    await f.engine.run(f.owner);
    f.results.clear();
    f.message.id = 'new-message';
    f.message.receivedAt = '2026-10-26T07:45:00Z';
    await f.engine.run(f.owner);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(2);
    expect((await f.engine.status(f.owner)).results[0].draftStatus).toBe('uncertain');
  });
  test('central default-model changes apply automatically without renewed personal consent', async () => {
    const f = fixture();
    (f.adapter.availability as jest.Mock).mockResolvedValue({
      available: true,
      modelLabel: 'New centrally configured default',
      modelFingerprint: 'b'.repeat(64),
    });
    const status = await f.engine.status(f.owner);
    expect(status.modelLabel).toBe('New centrally configured default');
    expect(status.settings.enabled).toBe(true);
    expect(status.settings.consentVersion).toBe('2026-10-25');
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect(f.store.pause).not.toHaveBeenCalled();
    await expect(
      f.engine.settings(f.owner, { ...f.jobs.get(f.owner)!.settings, enabled: true }),
    ).resolves.toBeUndefined();
  });
  test('enabled settings changed during guard invalidate the pending external call', async () => {
    const f = fixture();
    let calls = 0;
    (f.adapter.connection as jest.Mock).mockImplementation(async () => {
      if (++calls === 2)
        await f.store.saveSettings(
          f.owner,
          { ...f.jobs.get(f.owner)!.settings, startTime: '09:00' },
          new Date(),
        );
      return { connected: true, mailbox: 'alice@example.invalid' };
    });
    await f.engine.run(f.owner);
    expect(f.graph.categorize).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('failed durable intent audit blocks writes', async () => {
    const f = fixture();
    (f.adapter.audit as jest.Mock).mockImplementation(async (_owner, event) => {
      if (event === 'category_requested') throw Error('audit offline');
    });
    await f.engine.run(f.owner);
    expect(f.graph.categorize).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('pause during model request blocks every following mailbox write', async () => {
    const f = fixture();
    const analyze = f.adapter.analyze;
    f.adapter.analyze = async (...args) => {
      const value = await analyze(...args);
      await f.engine.pause(f.owner);
      return value;
    };
    await f.engine.run(f.owner);
    expect(f.graph.categorize).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('work window end during analysis stops scheduled writes', async () => {
    const f = fixture();
    const analyze = f.adapter.analyze;
    f.adapter.analyze = async (...args) => {
      const value = await analyze(...args);
      f.now('2026-10-26T16:00:00Z');
      return value;
    };
    await f.engine.run(f.owner, true);
    expect(f.graph.categorize).not.toHaveBeenCalled();
  });
  test('no automatic reads outside hours, explicit manual run works', async () => {
    const f = fixture();
    f.now('2026-10-26T20:00:00Z');
    await f.engine.run(f.owner, true);
    expect(f.graph.page).not.toHaveBeenCalled();
    expect(f.jobs.get(f.owner)?.nextRunAt).toBe('2026-10-27T07:00:00.000Z');
    await f.engine.run(f.owner);
    expect(f.graph.page).toHaveBeenCalledTimes(1);
  });
  test('disabled account never fetches mailbox', async () => {
    const f = fixture();
    f.jobs.get(f.owner)!.settings.enabled = false;
    await expect(f.engine.run(f.owner)).rejects.toThrow();
    expect(f.graph.page).not.toHaveBeenCalled();
  });
  test('no available default route never reads or modifies mail', async () => {
    const f = fixture();
    (f.adapter.availability as jest.Mock).mockResolvedValue({ available: false, modelLabel: '' });
    await expect(f.engine.run(f.owner)).rejects.toThrow();
    expect(f.graph.page).not.toHaveBeenCalled();
  });
  test('lease prevents concurrent manual requests from duplicating drafts', async () => {
    const f = fixture();
    await Promise.allSettled([f.engine.run(f.owner), f.engine.run(f.owner)]);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
  test('scheduled collision leaves the active worker and personal opt-in intact', async () => {
    const f = fixture();
    await f.store.claim(f.owner, 'manual-worker', new Date('2026-10-26T08:00:00Z'));
    await f.engine.tick();
    expect(f.store.pause).not.toHaveBeenCalled();
    expect(f.jobs.get(f.owner)?.settings.enabled).toBe(true);
    expect(f.jobs.get(f.owner)?.leaseToken).toBe('manual-worker');
    expect(f.graph.page).not.toHaveBeenCalled();
  });
  test('other user cannot access results or correct priority by known ID', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    f.jobs.set('bob', { ...structuredClone(f.jobs.get(f.owner)!), ownerId: 'bob' });
    const id = createHash('sha256')
      .update(JSON.stringify([f.owner, 'conversation']))
      .digest('hex');
    expect((await f.engine.status('bob')).results).toEqual([]);
    await expect(f.engine.priority('bob', id, 'important')).rejects.toThrow('nicht gefunden');
    expect(f.graph.categorize).toHaveBeenCalledTimes(1);
  });
  test('very long content goes to manual review, not model or auto draft', async () => {
    const f = fixture();
    f.message.bodyTruncated = true;
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect((await f.engine.status(f.owner)).results[0].action).toBe('review');
  });
  test('no full history backfill or pre-consent mail processing', async () => {
    const f = fixture();
    f.message.receivedAt = '2026-10-20T08:00:00Z';
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(f.graph.categorize).not.toHaveBeenCalled();
  });
  test('local disconnect purges metadata without deleting Outlook mail', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    await f.engine.disconnect(f.owner);
    expect(f.jobs.has(f.owner)).toBe(false);
    expect(f.results.size).toBe(0);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
});

describe('mail result content boundary', () => {
  function preview() {
    const f = fixture();
    const id = 'result-1';
    const result: StoredMailResult = {
      id,
      messageId: f.message.id,
      conversationId: f.message.conversationId,
      sourceHash: 'source',
      categoryApplied: true,
      subject: f.message.subject,
      sender: f.message.sender,
      receivedAt: f.message.receivedAt,
      priority: 'normal',
      summary: 'Zusammenfassung',
      reason: 'Anfrage',
      action: 'reply',
      questions: [],
      draftStatus: 'created',
      draftId: 'draft-id',
    };
    f.results.set(`${f.owner}:${id}`, result);
    const draft: MailMessage = {
      ...f.message,
      id: 'draft-id',
      isDraft: true,
      body: 'Aktueller Entwurf',
    };
    const originalRead = f.graph.message.getMockImplementation()!;
    f.graph.message.mockImplementation(async (messageId) => {
      await originalRead(messageId);
      return structuredClone(messageId === draft.id ? draft : f.message);
    });
    return { ...f, id, result, draft };
  }
  it('reads only the owner-selected original and current draft while paused without invoking model or mutations', async () => {
    const f = preview();
    f.jobs.get(f.owner)!.settings.enabled = false;
    const content = await f.engine.content(f.owner, f.id);
    expect(content).toEqual({
      resultId: f.id,
      mailbox: 'alice@example.invalid',
      message: {
        subject: f.message.subject,
        sender: f.message.sender,
        receivedAt: f.message.receivedAt,
        body: f.message.body,
        bodyTruncated: false,
      },
      draft: { subject: f.draft.subject, body: f.draft.body, bodyTruncated: false },
    });
    expect(f.graph.message.mock.calls.map(([id]) => id)).toEqual(['mail', 'draft-id']);
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(f.adapter.availability).not.toHaveBeenCalled();
    expect(f.graph.categorize).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect(f.graph.thread).not.toHaveBeenCalled();
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(f.store.putResult).not.toHaveBeenCalled();
    expect(f.adapter.audit).toHaveBeenNthCalledWith(1, f.owner, 'result_content_requested', f.id);
    expect(f.adapter.audit).toHaveBeenNthCalledWith(2, f.owner, 'result_content_read', f.id);
    expect((await f.engine.status(f.owner)).connection).not.toHaveProperty('generation');
  });
  it('cannot select another owner result or supply a Graph URL', async () => {
    const f = preview();
    f.jobs.set('bob', { ...f.jobs.get(f.owner)!, ownerId: 'bob' });
    await expect(f.engine.content('bob', f.id)).rejects.toThrow('Mail-Vorgang nicht gefunden');
    await expect(
      f.engine.content(f.owner, 'https://graph.microsoft.com/v1.0/me/messages/a'),
    ).rejects.toThrow();
    expect(f.graph.message).not.toHaveBeenCalled();
    expect(f.adapter.audit).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'unauthorized', 'disconnected', 'generation-missing', 'audit-failed'])(
    'fails closed before reading when %s',
    async (reason) => {
      const f = preview();
      if (reason === 'revoked') delete f.jobs.get(f.owner)!.settings.consentVersion;
      if (reason === 'unauthorized')
        jest.spyOn(f.adapter, 'authorize').mockRejectedValue(new Error('denied'));
      if (reason === 'disconnected')
        jest.spyOn(f.adapter, 'connection').mockResolvedValue({ connected: false });
      if (reason === 'generation-missing')
        jest
          .spyOn(f.adapter, 'connection')
          .mockResolvedValue({ connected: true, mailbox: 'alice@example.invalid' });
      if (reason === 'audit-failed')
        jest.spyOn(f.adapter, 'audit').mockRejectedValue(new Error('audit failed'));
      await expect(f.engine.content(f.owner, f.id)).rejects.toThrow();
      expect(f.graph.message).not.toHaveBeenCalled();
    },
  );
  it.each(['none', 'existing', 'stale', 'uncertain', 'error'] as const)(
    'does not treat stored draft state %s as editable',
    async (state) => {
      const f = preview();
      f.result.draftStatus = state;
      const content = await f.engine.content(f.owner, f.id);
      expect(content.draft).toBeUndefined();
      expect(content.draftUnavailable).toBe(true);
      expect(f.graph.message).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['sent', 'wrong-conversation', 'wrong-id', 'deleted', 'gone'])(
    'does not expose a %s draft',
    async (state) => {
      const f = preview();
      if (state === 'sent') f.draft.isDraft = false;
      if (state === 'wrong-conversation') f.draft.conversationId = 'other-conversation';
      if (state === 'wrong-id') {
        const read = f.graph.message.getMockImplementation()!;
        f.graph.message.mockImplementation(async (id) => ({
          ...(await read(id)),
          ...(id === 'draft-id' && { id: 'other-id' }),
        }));
      }
      if (state === 'deleted' || state === 'gone') {
        const read = f.graph.message.getMockImplementation()!;
        f.graph.message.mockImplementation(async (id) => {
          if (id === 'draft-id') throw new MailGraphError(state === 'deleted' ? 404 : 410);
          return read(id);
        });
      }
      const content = await f.engine.content(f.owner, f.id);
      expect(content.draft).toBeUndefined();
      expect(content.draftUnavailable).toBe(true);
    },
  );
  it('returns safe missing-original error and never reads its draft', async () => {
    const f = preview();
    f.graph.message.mockRejectedValue(new MailGraphError(404));
    await expect(f.engine.content(f.owner, f.id)).rejects.toThrow(
      'Die Originalmail ist nicht mehr verfügbar',
    );
    expect(f.graph.message).toHaveBeenCalledTimes(1);
  });
  it.each(['id', 'conversationId', 'isDraft'] as const)(
    'rejects an original with changed %s',
    async (field) => {
      const f = preview();
      if (field === 'isDraft') f.message.isDraft = true;
      else f.message[field] = 'different';
      await expect(f.engine.content(f.owner, f.id)).rejects.toThrow(
        'Originalmail passt nicht mehr',
      );
      expect(f.graph.message).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['consent', 'connection', 'reauth', 'result'])(
    'withholds content when %s changes during Graph response',
    async (change) => {
      const f = preview();
      const read = f.graph.message.getMockImplementation()!;
      f.graph.message.mockImplementation(async (id) => {
        const value = await read(id);
        if (change === 'consent') delete f.jobs.get(f.owner)!.settings.consentVersion;
        if (change === 'connection')
          jest.spyOn(f.adapter, 'connection').mockResolvedValue({ connected: false });
        if (change === 'reauth')
          jest.spyOn(f.adapter, 'connection').mockResolvedValue({
            connected: true,
            mailbox: 'alice@example.invalid',
            generation: 'connection-v2',
          });
        if (change === 'result') f.results.delete(`${f.owner}:${f.id}`);
        return value;
      });
      await expect(f.engine.content(f.owner, f.id)).rejects.toThrow();
      expect(f.adapter.audit).not.toHaveBeenCalledWith(f.owner, 'result_content_read', f.id);
    },
  );
  it('uses only fixed GET requests after audit and applies existing Graph text limits', async () => {
    const f = preview();
    const calls: Array<{ url: string; method: string }> = [];
    jest.spyOn(f.adapter, 'graph').mockImplementation(async (_owner, beforeRequest) =>
      createMailGraph({
        beforeRequest,
        token: async () => 'fixture-token',
        fetch: async (input, init) => {
          expect(f.adapter.audit).toHaveBeenCalledWith(f.owner, 'result_content_requested', f.id);
          const url = new URL(String(input));
          calls.push({ url: url.origin + url.pathname, method: init?.method ?? '' });
          const draft = url.pathname.endsWith('/draft-id');
          return new Response(
            JSON.stringify({
              id: draft ? 'draft-id' : 'mail',
              conversationId: 'conversation',
              subject: 'x'.repeat(600),
              from: { emailAddress: { address: 'alice@example.invalid' } },
              receivedDateTime: '2026-10-26T07:30:00Z',
              isDraft: draft,
              body: { content: 'x'.repeat(13000), contentType: 'text' },
            }),
          );
        },
      }),
    );
    const content = await f.engine.content(f.owner, f.id);
    expect(calls).toEqual([
      { url: 'https://graph.microsoft.com/v1.0/me/messages/mail', method: 'GET' },
      { url: 'https://graph.microsoft.com/v1.0/me/messages/draft-id', method: 'GET' },
    ]);
    expect(content.message.subject).toHaveLength(500);
    expect(content.message.body).toHaveLength(12000);
    expect(content.message.bodyTruncated).toBe(true);
    expect(content.draft?.body).toHaveLength(12000);
    expect(content.draft?.bodyTruncated).toBe(true);
    expect(content).not.toHaveProperty('message.id');
  });
  it('does not issue a Graph request if reauthorization races token acquisition', async () => {
    const f = preview();
    const fetch = jest.fn();
    jest.spyOn(f.adapter, 'graph').mockImplementation(async (_owner, beforeRequest) =>
      createMailGraph({
        beforeRequest,
        token: async () => {
          jest.spyOn(f.adapter, 'connection').mockResolvedValue({
            connected: true,
            mailbox: 'alice@example.invalid',
            generation: 'new-connection',
          });
          return 'old-fixture-token';
        },
        fetch,
      }),
    );
    await expect(f.engine.content(f.owner, f.id)).rejects.toThrow(
      'Postfachverbindung wurde verändert',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
