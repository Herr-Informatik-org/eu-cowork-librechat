import { createHash } from 'node:crypto';
import { createMailAssistantEngine, resultRevision } from './engine';
import { createMailGraph, MailGraphError } from './graph';
import { defaultMailSettings } from './schedule';
import { activeMoveJob, summarizeMove } from './moves';
import type {
  MailJob,
  MailStore,
  StoredMailResult,
  MailMessage,
  MailRuntimeAdapter,
  MailAnalysis,
  StoredMailMoveJob,
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
          consentVersion: '2026-10-27',
        },
      },
    ],
  ]);
  const results = new Map<string, StoredMailResult>();
  const moves = new Map<string, StoredMailMoveJob[]>();
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
    seedResults: jest.fn(async (_owner, values) =>
      values.map((value) => {
        if (!results.has(value.id)) results.set(value.id, copy(value));
        return copy(results.get(value.id)!);
      }),
    ),
    moveJobs: jest.fn(async (id) => copy(moves.get(id) ?? [])),
    enqueueMove: jest.fn(async (id, queue) => {
      const job = jobs.get(id);
      if (!job || job.revision !== queue.settingsRevision) return 'revoked';
      const existing = moves.get(id) ?? [];
      const same = existing.find((item) => item.id === queue.id);
      if (same) return same.requestHash === queue.requestHash ? 'duplicate' : 'busy';
      if (existing.some(activeMoveJob)) return 'busy';
      moves.set(id, [...existing, copy(queue)]);
      job.movePending = true;
      return 'accepted';
    }),
    updateMove: jest.fn(async (id, token, queue) => {
      const job = jobs.get(id);
      if (!job || job.leaseToken !== token || job.revision !== queue.settingsRevision) return false;
      const existing = moves.get(id) ?? [];
      if (!existing.some((item) => item.id === queue.id && activeMoveJob(item))) return false;
      const updated = existing.map((item) => (item.id === queue.id ? copy(queue) : item));
      moves.set(id, updated);
      job.movePending = updated.some(activeMoveJob);
      return true;
    }),
    cancelStaleMoves: jest.fn(async (id, now, queueId) => {
      const job = jobs.get(id);
      if (!job) return;
      const updated = (moves.get(id) ?? []).map((queue) =>
        !activeMoveJob(queue) ||
        (queue.id !== queueId &&
          queue.settingsRevision === job.revision &&
          job.settings.consentVersion === '2026-10-27')
          ? queue
          : summarizeMove(
              {
                ...queue,
                items: queue.items.map((item) => {
                  if (item.status === 'queued') return { ...item, status: 'cancelled' as const };
                  if (item.status === 'running') return { ...item, status: 'uncertain' as const };
                  return item;
                }),
              },
              now,
            ),
      );
      moves.set(id, updated);
      job.movePending = updated.some(activeMoveJob);
    }),
    movesDue: jest.fn(async (now) =>
      [...jobs]
        .filter(([, job]) => job.movePending && (!job.leaseUntil || job.leaseUntil < now))
        .map(([id]) => id),
    ),
    draftState: async (id, key) => operations.get(id + ':' + key) ?? null,
    reserveDraft: async (id, _token, key, sourceHash, retryFailed = false) => {
      const old = operations.get(id + ':' + key);
      if (
        old?.state === 'pending' ||
        (old?.sourceHash === sourceHash && !(retryFailed && old.state === 'failed'))
      )
        return false;
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
      delete jobs.get(id)!.continuation;
    }),
    pause: jest.fn(async (id) => {
      jobs.get(id)!.settings.enabled = false;
      jobs.get(id)!.revision++;
      delete jobs.get(id)!.leaseToken;
      delete jobs.get(id)!.leaseUntil;
      delete jobs.get(id)!.continuation;
    }),
    purge: jest.fn(async (id) => {
      jobs.delete(id);
      moves.delete(id);
      for (const key of results.keys()) if (key.startsWith(id + ':')) results.delete(key);
    }),
    due: jest.fn(async () =>
      [...jobs]
        .filter(
          ([, job]) =>
            job.settings.enabled &&
            (job.settings.mode === 'scheduled' || job.continuation?.mode === 'manual') &&
            (!job.nextRunAt || Date.parse(job.nextRunAt) <= instant.getTime()),
        )
        .map(([id]) => id),
    ),
    prune: jest.fn(async () => {}),
    claim: jest.fn(async (id, token, now, manual = false, revision) => {
      const job = jobs.get(id);
      if (
        !job ||
        (!manual && (!job.settings.enabled || job.movePending)) ||
        (job.leaseUntil && job.leaseUntil > now)
      )
        return null;
      if (revision !== undefined && job.revision !== revision) return null;
      job.leaseToken = token;
      job.leaseUntil = new Date(now.getTime() + 120000);
      return copy(job);
    }),
    update: jest.fn(async (id, token, fields) => {
      if (jobs.get(id)?.leaseToken !== token) return false;
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
      if (jobs.get(id)?.leaseToken !== token) throw Error('lost lease');
      results.set(id + ':' + result.id, copy(result));
    }),
  };
  let guard = async () => {};
  const graph = {
    attachments: jest.fn(async (_id: string) => ({ attachments: [], hasMore: false })),
    preview: jest.fn(async (_id: string) => ({
      html: '<p>Safe preview</p>',
      blockedImages: 0,
      truncated: false,
      warnings: [] as string[],
    })),
    folders: jest.fn(async () => [
      { id: 'folder', displayName: '00_erledigt', childFolderCount: 0, canMoveTo: true },
    ]),
    folder: jest.fn(async (_id: string) => ({
      id: 'folder',
      displayName: '00_erledigt',
      childFolderCount: 0,
      canMoveTo: true,
    })),
    move: jest.fn(async (_id: string, folderId: string) => ({
      ...copy(message),
      id: 'moved-mail',
      parentFolderId: folderId,
    })),
    editableReply: jest.fn(async (_id: string): Promise<{ text: string; etag: string }> => {
      throw new MailGraphError(409);
    }),
    editDraft: jest.fn(async (_id: string, _text: string, _etag: string) => {}),
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
    createReply: jest.fn(
      async (
        _id: string,
        _text: string,
      ): Promise<{ id: string; url?: string; warnings?: string[]; stop?: boolean }> => {
        await guard();
        return { id: 'draft-id', url: 'https://outlook.office.com/mail/draft' };
      },
    ),
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
    analyzeDraft: jest.fn(async () => 'Guten Tag\n\nGerne unterstützen wir Sie.'),
    audit: jest.fn(async () => {}),
  };
  const engine = createMailAssistantEngine({ store, adapter, now: () => instant });
  return {
    engine,
    owner,
    jobs,
    results,
    operations,
    moves,
    store,
    graph,
    adapter,
    message,
    now: (value: string) => {
      instant = new Date(value);
    },
  };
}

async function requestDraft(f: ReturnType<typeof fixture>, instructions = '') {
  const result = (await f.engine.results(f.owner, {})).results[0];
  return f.engine.requestDraft(f.owner, result.id, {
    revision: result.revision!,
    instructions,
    requestId: '17dc3b0d-0788-4a74-9c47-a7954e5ae28f',
  });
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
  test('an explicitly requested partial draft is retained with warnings and never automatically repeated', async () => {
    const f = fixture();
    f.graph.createReply.mockResolvedValue({
      id: 'draft-id',
      warnings: ['Anhang noch unvollständig'],
      stop: true,
    });
    await f.engine.run(f.owner);
    await requestDraft(f);
    const saved = [...f.results.values()][0];
    expect(saved).toMatchObject({
      draftStatus: 'created',
      draftId: 'draft-id',
      operationPending: false,
      draftWarnings: ['Anhang noch unvollständig'],
    });
    expect(f.jobs.get(f.owner)!.continuation).toBeNull();
    expect(f.jobs.get(f.owner)!.lastError).toBe('');
    await f.engine.run(f.owner);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
  test('old consent does not claim or mutate the deployed job before personal reconfirmation', async () => {
    const f = fixture();
    f.jobs.get(f.owner)!.settings.consentVersion = '2026-10-25';
    const before = structuredClone(f.jobs.get(f.owner));
    await expect(f.engine.run(f.owner)).rejects.toThrow('aktiviere');
    expect(f.store.claim).not.toHaveBeenCalled();
    expect(f.jobs.get(f.owner)).toEqual(before);
  });
  test('one manual request durably continues bounded batches after restart and stops at the live delta boundary', async () => {
    const f = backloggedFixture();
    f.jobs.get(f.owner)!.settings.mode = 'manual';
    f.now('2026-10-26T20:00:00Z');
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(20);
    expect(f.jobs.get(f.owner)!.continuation).toMatchObject({ mode: 'manual', revision: 1 });
    expect((await f.engine.status(f.owner)).activity.continuing).toBe(true);
    f.now('2026-10-26T20:00:02Z');
    const restarted = createMailAssistantEngine({
      store: f.store,
      adapter: f.adapter,
      now: () => new Date('2026-10-26T20:00:02Z'),
    });
    await restarted.tick();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(40);
    expect(f.jobs.get(f.owner)!.continuation).toBeNull();
    expect(f.jobs.get(f.owner)!.nextRunAt).toBe('');
    await restarted.tick();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(40);
    expect(f.graph.page).toHaveBeenCalledTimes(1);
  });
  test('unchanged continuation URLs stop the chain instead of repeatedly polling an empty page', async () => {
    const f = fixture();
    f.jobs.get(f.owner)!.checkpoint = { url: 'unchanged', pending: [] };
    f.graph.page.mockResolvedValue({ messages: [], nextUrl: 'unchanged', hasMore: true });
    await f.engine.run(f.owner);
    expect(f.jobs.get(f.owner)!.continuation).toBeNull();
    expect(f.jobs.get(f.owner)!.lastError).toContain('keine neue Posteingangsseite');
    expect(f.graph.page).toHaveBeenCalledTimes(1);
  });
  test('manual continuation cannot inherit new scheduled settings across a concurrent revision change', async () => {
    const f = backloggedFixture();
    f.jobs.get(f.owner)!.settings.mode = 'manual';
    f.now('2026-10-26T20:00:00Z');
    await f.engine.run(f.owner);
    f.now('2026-10-26T20:01:00Z');
    const read = f.store.read;
    let reads = 0;
    f.store.read = jest.fn(async (owner) => {
      const job = await read(owner);
      if (++reads === 1) {
        f.jobs.get(f.owner)!.revision++;
        f.jobs.get(f.owner)!.settings.mode = 'scheduled';
        delete f.jobs.get(f.owner)!.continuation;
      }
      return job;
    });
    await f.engine.tick();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(20);
    expect(f.jobs.get(f.owner)!.settings.enabled).toBe(true);
  });
  test('pausing cancels persisted continuation before another batch', async () => {
    const f = backloggedFixture();
    f.jobs.get(f.owner)!.settings.mode = 'manual';
    await f.engine.run(f.owner);
    await f.engine.pause(f.owner);
    f.now('2026-10-26T08:01:00Z');
    await f.engine.tick();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(20);
    expect(f.jobs.get(f.owner)!.continuation).toBeUndefined();
  });
  test('an error stops continuation without discarding pending messages', async () => {
    const f = backloggedFixture();
    f.jobs.get(f.owner)!.settings.mode = 'manual';
    await f.engine.run(f.owner);
    (f.adapter.analyze as jest.Mock).mockRejectedValue(new Error('provider unavailable'));
    f.now('2026-10-26T08:01:00Z');
    await f.engine.tick();
    expect(f.jobs.get(f.owner)!.continuation).toBeNull();
    expect(f.jobs.get(f.owner)!.checkpoint!.pending).toHaveLength(10);
    expect(f.jobs.get(f.owner)!.lastError).toContain('angehalten');
  });
  test('scheduled continuation never bypasses the end of working hours', async () => {
    const f = backloggedFixture();
    f.now('2026-10-26T15:59:00Z');
    await f.engine.run(f.owner, true);
    f.now('2026-10-26T16:00:00Z');
    await f.engine.tick();
    expect(f.adapter.analyze).toHaveBeenCalledTimes(20);
    expect(f.jobs.get(f.owner)!.nextRunAt).toBe('2026-10-27T07:00:00.000Z');
    expect(f.jobs.get(f.owner)!.continuation?.mode).toBe('scheduled');
  });
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
    expect(f.graph.createReply).not.toHaveBeenCalled();
    await f.engine.run(f.owner);
    expect(f.graph.historyPage).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).not.toHaveBeenCalled();
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
    await requestDraft(f);
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
  test('creates a reply draft only after a separate user request and keeps existing categories, questions only in overview', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
    await requestDraft(f, 'Bitte kurz und freundlich antworten.');
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
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
  test('a changed Outlook action marker does not reanalyse, create a draft or change revision', async () => {
    const f = fixture();
    await f.engine.run(f.owner);
    const first = (await f.engine.status(f.owner)).results[0];
    f.message.responseAction = 'forwarded';
    f.message.responseActionAt = '2026-10-26T08:01:00.000Z';
    f.message.changeKey = 'new-outlook-status';
    await f.engine.run(f.owner);
    const refreshed = (await f.engine.status(f.owner)).results[0];
    expect(refreshed.revision).toBe(first.revision);
    expect(refreshed.action).toBe(first.action);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.graph.categorize).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect(f.graph.move).not.toHaveBeenCalled();
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
    expect(await requestDraft(f)).toEqual({ status: 'uncertain' });
    expect(await requestDraft(f)).toEqual({ status: 'uncertain' });
    await f.engine.run(f.owner);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect((await f.engine.status(f.owner)).results[0].draftStatus).toBe('uncertain');
  });
  test('unknown POST barrier survives result expiry and still allows new summaries', async () => {
    const f = fixture();
    f.graph.createReply.mockRejectedValue(new MailGraphError(0, true));
    await f.engine.run(f.owner);
    await requestDraft(f);
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
    expect(status.settings.consentVersion).toBe('2026-10-27');
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).not.toHaveBeenCalled();
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
    await f.engine.run(f.owner);
    await Promise.allSettled([requestDraft(f), requestDraft(f)]);
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
    expect(f.graph.createReply).not.toHaveBeenCalled();
  });
});

describe('explicit manual drafts and attachment metadata', () => {
  async function prepared() {
    const f = fixture();
    await f.engine.run(f.owner);
    const result = (await f.engine.results(f.owner, {})).results[0];
    return { ...f, result };
  }
  test.each([false, true])(
    'analysis never generates drafts or reads attachment bytes (scheduled=%s)',
    async (scheduled) => {
      const f = fixture();
      await f.engine.run(f.owner, scheduled);
      expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
      expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
      expect(f.graph.createReply).not.toHaveBeenCalled();
      expect(f.graph.attachments).not.toHaveBeenCalled();
      expect(f.graph.preview).not.toHaveBeenCalled();
      expect(f.operations.size).toBe(0);
    },
  );
  test('user instructions stay separate from hostile mail and only the explicit request creates a draft', async () => {
    const f = await prepared();
    const instructions = 'Bitte Termin am Freitag vorschlagen.';
    await expect(requestDraft(f, instructions)).resolves.toEqual({
      status: 'created',
      draftUrl: 'https://outlook.office.com/mail/draft',
    });
    expect(f.adapter.analyzeDraft).toHaveBeenCalledWith(
      f.owner,
      [expect.objectContaining({ id: 'mail' })],
      instructions,
      expect.any(Function),
      {
        sender: { name: '', address: 'alice@example.invalid' },
        recipients: [{ name: '', address: 'customer@example.invalid' }],
        signatureEnabled: false,
      },
    );
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).toHaveBeenCalledWith(
      'mail',
      'Guten Tag\n\nGerne unterstützen wir Sie.',
      undefined,
    );
    expect(JSON.stringify([...f.results.values()])).not.toContain(instructions);
    expect(JSON.stringify([...f.operations.values()])).not.toContain(instructions);
    await expect(requestDraft(f, 'Andere Bitte')).resolves.toMatchObject({ status: 'existing' });
    expect(f.adapter.analyzeDraft).toHaveBeenCalledTimes(1);
    expect(f.graph.createReply).toHaveBeenCalledTimes(1);
  });
  test('uses confirmed owner and reply-to identities and keeps signature outside the model', async () => {
    const f = await prepared();
    const identity = await f.graph.identity();
    f.graph.identity.mockResolvedValue(Object.assign(identity, { displayName: 'Alice Owner' }));
    const original = f.message;
    original.replyTo = [{ name: 'Actual recipient', address: 'reply@example.invalid' }];
    original.senderName = 'Quoted colleague';
    await requestDraft(f, 'Bitte freundlich antworten');
    expect(jest.mocked(f.adapter.analyzeDraft!).mock.calls[0][4]).toMatchObject({
      sender: { name: 'Alice Owner', address: 'alice@example.invalid' },
      recipients: [{ name: 'Actual recipient', address: 'reply@example.invalid' }],
    });
  });
  test('an existing human draft is linked and persisted but never rewritten or duplicated', async () => {
    const f = await prepared();
    f.graph.thread.mockResolvedValue({
      complete: true,
      messages: [
        f.message,
        {
          ...f.message,
          id: 'human',
          isDraft: true,
          messageUrl: 'https://outlook.office.com/mail/human',
        },
      ],
    });
    await expect(requestDraft(f)).resolves.toEqual({
      status: 'existing',
      draftUrl: 'https://outlook.office.com/mail/human',
    });
    expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect(f.graph.editDraft).not.toHaveBeenCalled();
    expect((await f.engine.results(f.owner, {})).results[0]).toMatchObject({
      draftStatus: 'existing',
      draftUrl: 'https://outlook.office.com/mail/human',
    });
  });
  test.each(['draft', 'reply', 'message'])(
    'a %s appearing while drafting blocks creation',
    async (change) => {
      const f = await prepared();
      (f.adapter.analyzeDraft as jest.Mock).mockImplementation(async () => {
        f.graph.thread.mockResolvedValue({
          complete: true,
          messages: [
            f.message,
            {
              ...f.message,
              id: 'raced',
              isDraft: change === 'draft',
              sentByUser: change === 'reply',
              receivedAt: '2026-10-26T07:59:00Z',
              sentAt: '2026-10-26T07:59:00Z',
            },
          ],
        });
        return 'Proposed reply';
      });
      if (change === 'draft')
        await expect(requestDraft(f)).resolves.toMatchObject({ status: 'existing' });
      else await expect(requestDraft(f)).rejects.toThrow('inzwischen geändert');
      expect(f.graph.createReply).not.toHaveBeenCalled();
      expect(f.operations.size).toBe(0);
    },
  );
  test.each(['body', 'revision', 'owner'])(
    'stale or foreign selection %s cannot create a draft',
    async (change) => {
      const f = await prepared();
      if (change === 'body') f.message.body += ' changed';
      await expect(
        f.engine.requestDraft(change === 'owner' ? 'other-user' : f.owner, f.result.id, {
          revision: change === 'revision' ? '0'.repeat(64) : f.result.revision!,
          instructions: '',
          requestId: '17dc3b0d-0788-4a74-9c47-a7954e5ae28f',
        }),
      ).rejects.toThrow();
      expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
      expect(f.graph.createReply).not.toHaveBeenCalled();
    },
  );
  test.each(['instructions', 'uuid', 'extra'])(
    'unbounded or unexpected request %s is rejected before lease',
    async (change) => {
      const f = await prepared();
      const calls = (f.store.claim as jest.Mock).mock.calls.length;
      await expect(
        f.engine.requestDraft(f.owner, f.result.id, {
          revision: f.result.revision!,
          instructions: change === 'instructions' ? 'x'.repeat(4001) : '',
          requestId: change === 'uuid' ? 'invalid' : '17dc3b0d-0788-4a74-9c47-a7954e5ae28f',
          ...(change === 'extra' && { send: true }),
        }),
      ).rejects.toThrow();
      expect(f.store.claim).toHaveBeenCalledTimes(calls);
      expect(f.graph.createReply).not.toHaveBeenCalled();
    },
  );
  test.each(['pause', 'reconnect', 'audit'])(
    'revocation or failed audit %s blocks draft writes',
    async (change) => {
      const f = await prepared();
      if (change === 'audit')
        (f.adapter.audit as jest.Mock).mockImplementation(async (_owner, event) => {
          if (event === 'manual_draft_requested') throw Error('audit unavailable');
        });
      else
        (f.adapter.analyzeDraft as jest.Mock).mockImplementation(async () => {
          if (change === 'pause') await f.engine.pause(f.owner);
          else
            (f.adapter.connection as jest.Mock).mockResolvedValue({
              connected: true,
              mailbox: 'other@example.invalid',
              generation: 'changed',
            });
          return 'Reply';
        });
      await expect(requestDraft(f)).rejects.toThrow();
      expect(f.graph.createReply).not.toHaveBeenCalled();
      expect(f.operations.size).toBe(0);
    },
  );
  test.each(['', 'x'.repeat(12001), { tool_calls: [{ name: 'sendMail' }] }])(
    'invalid model output cannot authorize a Graph write',
    async (value) => {
      const f = await prepared();
      (f.adapter.analyzeDraft as jest.Mock).mockResolvedValue(value);
      await expect(requestDraft(f)).rejects.toThrow();
      expect(f.graph.createReply).not.toHaveBeenCalled();
      expect(f.operations.size).toBe(0);
    },
  );
  test('attachment discovery is explicit, bounded to the selected owner result and never invokes model or writes', async () => {
    const f = await prepared();
    expect(f.graph.attachments).not.toHaveBeenCalled();
    await expect(f.engine.attachments(f.owner, f.result.id)).resolves.toEqual({
      attachments: [],
      hasMore: false,
    });
    expect(f.graph.attachments).toHaveBeenCalledWith('mail');
    expect(f.adapter.analyzeDraft).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
    await expect(f.engine.attachments('other-user', f.result.id)).rejects.toThrow();
    expect(f.graph.attachments).toHaveBeenCalledTimes(1);
  });
  test('changed connection during attachment metadata retrieval withholds its response', async () => {
    const f = await prepared();
    f.graph.attachments.mockImplementation(async () => {
      (f.adapter.connection as jest.Mock).mockResolvedValue({ connected: false });
      return { attachments: [], hasMore: false };
    });
    await expect(f.engine.attachments(f.owner, f.result.id)).rejects.toThrow('Postfachverbindung');
  });
  test('unsafe returned draft URLs never reach response or result storage', async () => {
    const f = await prepared();
    f.graph.createReply.mockResolvedValue({
      id: 'draft-id',
      url: 'https://outlook.office.com.attacker.test/private',
    });
    await expect(requestDraft(f)).resolves.toEqual({ status: 'created' });
    expect((await f.engine.results(f.owner, {})).results[0].draftUrl).toBeUndefined();
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
    f.message.responseAction = 'replied';
    f.message.responseActionAt = '2026-10-26T07:45:00.000Z';
    f.jobs.get(f.owner)!.settings.enabled = false;
    const content = await f.engine.content(f.owner, f.id);
    expect(content).toMatchObject({
      resultId: f.id,
      mailbox: 'alice@example.invalid',
      message: {
        subject: f.message.subject,
        sender: f.message.sender,
        receivedAt: f.message.receivedAt,
        body: f.message.body,
        bodyTruncated: false,
        responseAction: 'replied',
        responseActionAt: '2026-10-26T07:45:00.000Z',
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
  it('loads embedded images only on explicit owner request without models or mail writes', async () => {
    const f = preview();
    const result = await f.engine.images(f.owner, f.id, 'original', resultRevision(f.result));
    expect(result.html).toContain('Safe preview');
    expect(f.graph.preview).toHaveBeenCalledWith('mail', true);
    expect(f.graph.message.mock.calls.map(([id]) => id)).toEqual(['mail', 'mail']);
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(f.graph.createReply).not.toHaveBeenCalled();
    expect(f.store.putResult).not.toHaveBeenCalled();
    expect(f.adapter.audit).toHaveBeenNthCalledWith(1, f.owner, 'embedded_images_requested', f.id);
    expect(f.adapter.audit).toHaveBeenNthCalledWith(2, f.owner, 'embedded_images_read', f.id);
  });
  it('requires matching result revision, owner and a still-existing draft for images', async () => {
    const f = preview();
    await expect(f.engine.images(f.owner, f.id, 'original', '0'.repeat(64))).rejects.toThrow(
      'verändert',
    );
    f.jobs.set('bob', { ...f.jobs.get(f.owner)!, ownerId: 'bob' });
    await expect(
      f.engine.images('bob', f.id, 'original', resultRevision(f.result)),
    ).rejects.toThrow('Mail-Vorgang nicht gefunden');
    f.draft.isDraft = false;
    await expect(f.engine.images(f.owner, f.id, 'draft', resultRevision(f.result))).rejects.toThrow(
      'passt nicht',
    );
    expect(f.graph.preview).not.toHaveBeenCalled();
  });
  it('rejects changed or sent messages after image processing and never returns their bytes', async () => {
    const f = preview();
    f.graph.preview.mockImplementation(async () => {
      f.draft.isDraft = false;
      return { html: '<p>Image bytes</p>', blockedImages: 0, truncated: false, warnings: [] };
    });
    await expect(f.engine.images(f.owner, f.id, 'draft', resultRevision(f.result))).rejects.toThrow(
      'während des Ladens',
    );
    expect(f.adapter.audit).not.toHaveBeenCalledWith(f.owner, 'embedded_images_read', f.id);
  });
  it('does not return image content if consent or connection changes during loading', async () => {
    const f = preview();
    f.graph.preview.mockImplementation(async () => {
      f.jobs.get(f.owner)!.revision++;
      return { html: '<p>Image bytes</p>', blockedImages: 0, truncated: false, warnings: [] };
    });
    await expect(
      f.engine.images(f.owner, f.id, 'original', resultRevision(f.result)),
    ).rejects.toThrow('Freigabe');
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
  it.each(['none', 'uncertain', 'error'] as const)(
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
      { url: 'https://graph.microsoft.com/v1.0/me/messages/mail', method: 'GET' },
      { url: 'https://graph.microsoft.com/v1.0/me/messages/draft-id', method: 'GET' },
      { url: 'https://graph.microsoft.com/v1.0/me/messages/draft-id', method: 'GET' },
      { url: 'https://graph.microsoft.com/v1.0/me/messages/draft-id', method: 'GET' },
    ]);
    expect(content.message.subject).toHaveLength(500);
    expect(content.message.body).toHaveLength(12000);
    expect(content.message.bodyTruncated).toBe(true);
    expect(content.draft?.body).toHaveLength(12000);
    expect(content.draft?.bodyTruncated).toBe(true);
    expect(content).not.toHaveProperty('message.id');
  });
  test.each(['existing', 'stale'] as const)(
    'owned %s draft exposes only a safe URL and read-only preview',
    async (state) => {
      const f = preview();
      const saved = f.results.get(`${f.owner}:${f.id}`)!;
      saved.draftStatus = state;
      const read = f.graph.message.getMockImplementation()!;
      f.graph.message.mockImplementation(async (id) => ({
        ...(await read(id)),
        ...(id === 'draft-id' && { messageUrl: 'https://outlook.office.com/mail/draft-id' }),
      }));
      const content = await f.engine.content(f.owner, f.id);
      expect(content.draft?.url).toBe('https://outlook.office.com/mail/draft-id');
      expect(content.draft?.replyText).toBeUndefined();
      expect(content.draft?.revision).toBeUndefined();
      expect(f.graph.editableReply).not.toHaveBeenCalled();
    },
  );
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

describe('personal mail workspace mutations', () => {
  async function processed() {
    const f = fixture();
    await f.engine.run(f.owner);
    await requestDraft(f);
    const result = [...f.results.values()][0];
    const revision = (await f.engine.results(f.owner, {})).results[0].revision!;
    return { ...f, result, revision };
  }
  async function moveFixture(count = 2) {
    const f = await processed();
    f.results.clear();
    const messages = Array.from({ length: count }, (_, index) => ({
      ...f.message,
      id: `mail-${index}`,
      conversationId: `conversation-${index}`,
    }));
    for (const [index, message] of messages.entries()) {
      const id = createHash('sha256').update(`result-${index}`).digest('hex');
      f.results.set(`${f.owner}:${id}`, {
        ...f.result,
        id,
        messageId: message.id,
        conversationId: message.conversationId,
        sourceHash: `source-${index}`,
      });
    }
    f.graph.message.mockImplementation(async (id) =>
      structuredClone(messages.find((message) => message.id === id)!),
    );
    f.graph.move.mockImplementation(async (id, folderId) => ({
      ...messages.find((message) => message.id === id)!,
      id: `moved-${id}`,
      parentFolderId: folderId,
    }));
    const items = (await f.engine.results(f.owner, {})).results.map((result) => ({
      id: result.id,
      revision: result.revision!,
    }));
    const request = {
      requestId: '00000000-0000-4000-8000-000000000001',
      folderId: 'folder',
      items,
    };
    return { ...f, messages, request };
  }
  test('accepts one bound job immediately during analysis, with no Graph or model work and idempotent retries', async () => {
    const f = await moveFixture();
    f.graph.folder.mockClear();
    f.graph.message.mockClear();
    jest.mocked(f.adapter.analyze).mockClear();
    f.jobs.get(f.owner)!.leaseToken = 'analysing';
    f.jobs.get(f.owner)!.leaseUntil = new Date('2026-10-26T08:01:00Z');
    const job = await f.engine.enqueueMove(f.owner, f.request);
    expect(job).toMatchObject({ status: 'queued', total: 2, completed: 0 });
    expect(f.graph.folder).not.toHaveBeenCalled();
    expect(f.graph.message).not.toHaveBeenCalled();
    expect(f.graph.move).not.toHaveBeenCalled();
    expect(f.adapter.analyze).not.toHaveBeenCalled();
    expect(await f.engine.enqueueMove(f.owner, f.request)).toEqual(job);
    expect(f.moves.get(f.owner)).toHaveLength(1);
    await expect(
      f.engine.enqueueMove(f.owner, { ...f.request, folderId: 'other' }),
    ).rejects.toThrow('anderen Auswahl');
    await expect(
      f.engine.enqueueMove(f.owner, {
        ...f.request,
        requestId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toThrow('läuft bereits');
  });
  test('persists progress across restart and releases the lease after each mail', async () => {
    const f = await moveFixture();
    await f.engine.enqueueMove(f.owner, f.request);
    const restarted = createMailAssistantEngine({
      store: f.store,
      adapter: f.adapter,
      now: () => new Date('2026-10-26T08:00:00Z'),
    });
    await restarted.tick();
    expect((await restarted.moveJobs(f.owner))[0]).toMatchObject({
      total: 2,
      completed: 1,
      status: 'queued',
    });
    expect(f.jobs.get(f.owner)?.leaseToken).toBeUndefined();
    expect(f.graph.move).toHaveBeenCalledTimes(1);
    await restarted.tick();
    const completed = (await restarted.moveJobs(f.owner))[0];
    expect(completed).toMatchObject({
      completed: 2,
      failed: 0,
      status: 'completed',
      folderName: '00_erledigt',
    });
    expect(completed).not.toHaveProperty('mailbox');
    expect(completed).not.toHaveProperty('connectionGeneration');
    expect(completed.items[0]).not.toHaveProperty('revision');
    expect(f.graph.move).toHaveBeenCalledTimes(2);
    await restarted.tick();
    expect(f.graph.move).toHaveBeenCalledTimes(2);
  });
  test.each(['released', 'paused'] as const)(
    'a coalesced wakeup retries a busy manual lease until it is %s',
    async (outcome) => {
      const f = await moveFixture(1);
      jest.useFakeTimers();
      try {
        f.engine.start();
        f.jobs.get(f.owner)!.leaseToken = 'manual-editor';
        f.jobs.get(f.owner)!.leaseUntil = new Date('2026-10-26T08:01:00Z');
        await f.engine.enqueueMove(f.owner, f.request);
        await jest.advanceTimersByTimeAsync(1000);
        expect(f.graph.move).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(2);
        if (outcome === 'released') {
          await f.store.release(f.owner, 'manual-editor', {});
        } else {
          await f.engine.pause(f.owner);
        }
        await jest.advanceTimersByTimeAsync(1000);
        expect(f.graph.move).toHaveBeenCalledTimes(outcome === 'released' ? 1 : 0);
        expect((await f.engine.moveJobs(f.owner))[0].status).toBe(
          outcome === 'released' ? 'completed' : 'cancelled',
        );
        expect(jest.getTimerCount()).toBe(1);
      } finally {
        f.engine.stop();
        jest.useRealTimers();
      }
    },
  );
  test('a stale queued selection fails individually while unchanged selected mails can complete', async () => {
    const f = await moveFixture();
    await f.engine.enqueueMove(f.owner, f.request);
    f.results.get(`${f.owner}:${f.request.items[0].id}`)!.messageId = 'new-mail';
    await f.engine.tick();
    expect(f.graph.move).not.toHaveBeenCalled();
    await f.engine.tick();
    expect((await f.engine.moveJobs(f.owner))[0]).toMatchObject({
      status: 'partial',
      completed: 1,
      failed: 1,
    });
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test.each(['pause', 'settings', 'connection'] as const)(
    'revoking %s cancels queued work without a Graph mutation',
    async (change) => {
      const f = await moveFixture();
      await f.engine.enqueueMove(f.owner, f.request);
      if (change === 'pause') await f.engine.pause(f.owner);
      if (change === 'settings') await f.engine.settings(f.owner, f.jobs.get(f.owner)!.settings);
      if (change === 'connection')
        jest.spyOn(f.adapter, 'connection').mockResolvedValue({
          connected: true,
          mailbox: 'alice@example.invalid',
          generation: 'replacement',
        });
      await f.engine.tick();
      expect(f.graph.move).not.toHaveBeenCalled();
      expect((await f.engine.moveJobs(f.owner))[0].status).toBe('cancelled');
    },
  );
  test('an explicit new job works while analysis is paused without resuming it', async () => {
    const f = await moveFixture(1);
    await f.engine.pause(f.owner);
    await f.engine.enqueueMove(f.owner, f.request);
    await f.engine.tick();
    expect((await f.engine.moveJobs(f.owner))[0].status).toBe('completed');
    expect(f.jobs.get(f.owner)!.settings.enabled).toBe(false);
  });
  test('uncertain moves stop the remaining job and are never replayed after restart', async () => {
    const f = await moveFixture();
    await f.engine.enqueueMove(f.owner, f.request);
    f.graph.move.mockRejectedValueOnce(new MailGraphError(0, true));
    await f.engine.tick();
    const status = (await f.engine.moveJobs(f.owner))[0];
    expect(status.items.map((item) => item.status)).toEqual(['uncertain', 'cancelled']);
    const restarted = createMailAssistantEngine({
      store: f.store,
      adapter: f.adapter,
      now: () => new Date('2026-10-26T08:00:00Z'),
    });
    await restarted.tick();
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test('a crashed in-flight item is reconciled conservatively without repeating its move', async () => {
    const f = await moveFixture(1);
    await f.engine.enqueueMove(f.owner, f.request);
    f.moves.get(f.owner)![0].status = 'running';
    f.moves.get(f.owner)![0].items[0].status = 'running';
    await f.engine.tick();
    expect(f.graph.move).not.toHaveBeenCalled();
    expect((await f.engine.moveJobs(f.owner))[0].items[0].status).toBe('uncertain');
  });
  test('a pause during the Graph write leaves an uncertain outcome without replay', async () => {
    const f = await moveFixture();
    await f.engine.enqueueMove(f.owner, f.request);
    const original = f.graph.move.getMockImplementation()!;
    f.graph.move.mockImplementation(async (id, folder) => {
      const value = await original(id, folder);
      await f.engine.pause(f.owner);
      return value;
    });
    await f.engine.tick();
    expect((await f.engine.moveJobs(f.owner))[0].items.map((item) => item.status)).toEqual([
      'uncertain',
      'cancelled',
    ]);
    await f.engine.tick();
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test('queue snapshots cannot access another owner, forged IDs, duplicate selections or unbounded batches', async () => {
    const f = await moveFixture(1);
    f.jobs.set('bob', { ...f.jobs.get(f.owner)!, ownerId: 'bob' });
    expect(await f.engine.moveJobs('bob')).toEqual([]);
    await expect(f.engine.enqueueMove('bob', f.request)).rejects.toThrow('verändert');
    for (const items of [
      [...f.request.items, ...f.request.items],
      Array.from({ length: 101 }, () => f.request.items[0]),
      [{ id: 'https://graph.microsoft.com/me/messages/x', revision: f.request.items[0].revision }],
    ])
      await expect(f.engine.enqueueMove(f.owner, { ...f.request, items })).rejects.toThrow();
    expect(f.graph.move).not.toHaveBeenCalled();
  });
  test('analysis yields after the current mail rather than completing the remaining batch', async () => {
    const f = await moveFixture(1);
    const backlog = Array.from({ length: 20 }, (_, index) => ({
      ...f.message,
      id: `new-${index}`,
      conversationId: `new-conversation-${index}`,
    }));
    f.graph.page.mockResolvedValue({ messages: backlog, nextUrl: 'cursor', hasMore: false });
    f.jobs.get(f.owner)!.checkpoint = { pending: backlog.map((item) => item.id) };
    const originalRead = f.graph.message.getMockImplementation()!;
    f.graph.message.mockImplementation(async (id) =>
      structuredClone(backlog.find((item) => item.id === id) ?? (await originalRead(id))),
    );
    f.graph.thread.mockImplementation(async () => ({ messages: [], complete: true }));
    jest.spyOn(f.adapter, 'analyze').mockImplementationOnce(async () => {
      await f.engine.enqueueMove(f.owner, f.request);
      return {
        priority: 'normal',
        action: 'information',
        summary: 'S',
        reason: 'R',
        questions: [],
        draft: '',
      };
    });
    jest.mocked(f.adapter.analyze).mockClear();
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(1);
    expect(f.jobs.get(f.owner)?.checkpoint?.pending).toHaveLength(19);
    expect(f.jobs.get(f.owner)?.continuation).toBeTruthy();
    expect(f.jobs.get(f.owner)?.leaseToken).toBeUndefined();
    await f.engine.tick();
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test('manually moves only a saved own original, persists new Graph id, and is idempotent', async () => {
    const f = await processed();
    const result = await f.engine.move(f.owner, f.result.id, 'folder', f.revision);
    expect(result).toMatchObject({ moveStatus: 'completed', doneFolder: '00_erledigt' });
    expect(result).not.toHaveProperty('messageId');
    expect(result).not.toHaveProperty('moveDestination');
    expect(f.graph.move).toHaveBeenCalledWith('mail', 'folder', 'W/"version"');
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.messageId).toBe('moved-mail');
    await f.engine.move(f.owner, f.result.id, 'folder', result.revision!);
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test('manual review and filing work while AI is paused and do not resume its schedule', async () => {
    const f = await processed();
    await f.engine.pause(f.owner);
    jest.spyOn(f.adapter, 'availability').mockResolvedValue({ available: false, modelLabel: '' });
    await f.engine.move(f.owner, f.result.id, 'folder', f.revision);
    expect(f.jobs.get(f.owner)!.settings.enabled).toBe(false);
    expect(f.jobs.get(f.owner)!.continuation).toBeUndefined();
    expect(f.graph.move).toHaveBeenCalledTimes(1);
  });
  test('a manual priority change works while paused and mirrors only the own current draft category', async () => {
    const f = await processed();
    await f.engine.pause(f.owner);
    f.graph.message.mockImplementation(async (id) => ({
      ...f.message,
      id,
      isDraft: id === 'draft-id',
      categories: id === 'draft-id' ? ['Customer', 'KI: Normal'] : ['Original'],
    }));
    f.graph.categorize.mockClear();
    await f.engine.priority(f.owner, f.result.id, 'important');
    expect(f.graph.categorize.mock.calls).toEqual([
      ['mail', ['Original', 'KI: Wichtig'], 'W/"version"'],
      ['draft-id', ['Customer', 'KI: Wichtig'], 'W/"version"'],
    ]);
    expect(f.jobs.get(f.owner)!.settings.enabled).toBe(false);
  });
  test('a definite rejected manual move may be retried on a fresh click', async () => {
    const f = await processed();
    f.graph.move.mockRejectedValueOnce(new MailGraphError(403));
    await expect(f.engine.move(f.owner, f.result.id, 'folder', f.revision)).rejects.toThrow();
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.moveStatus).toBeUndefined();
    await f.engine.move(f.owner, f.result.id, 'folder', f.revision);
    expect(f.graph.move).toHaveBeenCalledTimes(2);
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.moveStatus).toBe('completed');
  });
  test('a newer mail in the same conversation cannot be moved using an old selection', async () => {
    const f = await processed();
    f.results.get(`${f.owner}:${f.result.id}`)!.messageId = 'newer-mail';
    await expect(f.engine.move(f.owner, f.result.id, 'folder', f.revision)).rejects.toThrow(
      'inzwischen verändert',
    );
    expect(f.graph.move).not.toHaveBeenCalled();
    expect(f.graph.folder).not.toHaveBeenCalled();
  });
  test('a queued moved mail keeps its done state and is not analysed again', async () => {
    const f = await processed();
    await f.engine.move(f.owner, f.result.id, 'folder', f.revision);
    const calls = (f.adapter.analyze as jest.Mock).mock.calls.length;
    f.message.id = 'moved-mail';
    f.jobs.get(f.owner)!.checkpoint = { pending: ['moved-mail'], hasMore: false };
    await f.engine.run(f.owner);
    expect(f.adapter.analyze).toHaveBeenCalledTimes(calls);
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.moveStatus).toBe('completed');
  });
  test('missing assistant draft does not prevent manual original categorization', async () => {
    const f = await processed();
    const original = f.graph.message.getMockImplementation()!;
    f.graph.message.mockImplementation(async (id) => {
      if (id === 'draft-id') throw new MailGraphError(404);
      return original(id);
    });
    await f.engine.priority(f.owner, f.result.id, 'important');
    expect(f.results.get(`${f.owner}:${f.result.id}`)).toMatchObject({
      priority: 'important',
      manualPriority: true,
    });
  });
  test('draft category conflict is visible and does not falsely mark the whole correction completed', async () => {
    const f = await processed();
    f.graph.message.mockImplementation(async (id) => ({
      ...f.message,
      id,
      isDraft: id === 'draft-id',
    }));
    f.graph.categorize.mockImplementation(async (id) => {
      if (id === 'draft-id') throw new MailGraphError(412);
    });
    await expect(f.engine.priority(f.owner, f.result.id, 'important')).rejects.toThrow();
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.manualPriority).not.toBe(true);
  });
  test('unknown move outcome keeps a durable barrier and never retries blindly', async () => {
    const f = await processed();
    f.graph.move.mockRejectedValue(new MailGraphError(0, true));
    await expect(f.engine.move(f.owner, f.result.id, 'folder', f.revision)).rejects.toThrow();
    await expect(f.engine.move(f.owner, f.result.id, 'folder', f.revision)).rejects.toThrow(
      'unklar',
    );
    expect(f.graph.move).toHaveBeenCalledTimes(1);
    expect(f.results.get(`${f.owner}:${f.result.id}`)?.moveStatus).toBe('uncertain');
  });
  test.each([
    'foreign-result',
    'system-folder',
    'changed-original',
    'audit-failed',
    'consent-revoked',
  ])('prevents manual move for %s', async (failure) => {
    const f = await processed();
    if (failure === 'system-folder')
      f.graph.folder.mockResolvedValue({
        id: 'folder',
        displayName: 'Drafts',
        childFolderCount: 0,
        canMoveTo: false,
      });
    if (failure === 'changed-original') f.message.conversationId = 'another';
    if (failure === 'audit-failed')
      jest.spyOn(f.adapter, 'audit').mockRejectedValue(Error('audit'));
    if (failure === 'consent-revoked') delete f.jobs.get(f.owner)!.settings.consentVersion;
    await expect(
      f.engine.move(
        f.owner,
        failure === 'foreign-result' ? 'a'.repeat(64) : f.result.id,
        'folder',
        f.revision,
      ),
    ).rejects.toThrow();
    expect(f.graph.move).not.toHaveBeenCalled();
  });
  test('explicit editing requires unchanged owned draft revision and preserves the reply-only contract', async () => {
    const f = await processed();
    f.graph.message.mockImplementation(async (id) => ({
      ...f.message,
      id,
      isDraft: id === 'draft-id',
    }));
    f.graph.editableReply.mockResolvedValue({ text: 'Old reply', etag: 'W/"draft-v1"' });
    const content = await f.engine.content(f.owner, f.result.id);
    expect(content.draft?.replyText).toBe('Old reply');
    await f.engine.editDraft(f.owner, f.result.id, 'Edited reply', content.draft!.revision!);
    expect(f.graph.editDraft).toHaveBeenCalledWith('draft-id', 'Edited reply', 'W/"draft-v1"');
    f.graph.editableReply.mockResolvedValue({ text: 'Changed by employee', etag: 'W/"draft-v2"' });
    await expect(
      f.engine.editDraft(f.owner, f.result.id, 'Stale reply', content.draft!.revision!),
    ).rejects.toThrow('inzwischen geändert');
    expect(f.graph.editDraft).toHaveBeenCalledTimes(1);
  });
  test('unknown draft save outcome blocks further changes and hides the editor', async () => {
    const f = await processed();
    f.graph.message.mockImplementation(async (id) => ({
      ...f.message,
      id,
      isDraft: id === 'draft-id',
    }));
    f.graph.editableReply.mockResolvedValue({ text: 'Old reply', etag: 'W/"draft-v1"' });
    const content = await f.engine.content(f.owner, f.result.id);
    f.graph.editDraft.mockRejectedValue(new MailGraphError(0, true));
    await expect(
      f.engine.editDraft(f.owner, f.result.id, 'New reply', content.draft!.revision!),
    ).rejects.toThrow();
    expect((await f.engine.content(f.owner, f.result.id)).draft?.revision).toBeUndefined();
    await expect(
      f.engine.editDraft(f.owner, f.result.id, 'Retry', content.draft!.revision!),
    ).rejects.toThrow();
    expect(f.graph.editDraft).toHaveBeenCalledTimes(1);
  });
  test('cursor pages expose all retained results, bind filters/owner and never expose stored Graph ids', async () => {
    const f = await processed();
    f.results.clear();
    for (let n = 0; n < 315; n++) {
      const id = n.toString(16).padStart(64, '0');
      f.results.set(`${f.owner}:${id}`, { ...f.result, id, subject: `Support ${n}` });
    }
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = await f.engine.results(f.owner, { cursor, search: 'support', state: 'open' });
      expect(page.results.length).toBeLessThanOrEqual(50);
      expect(page.results[0]).not.toHaveProperty('messageId');
      ids.push(...page.results.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(315);
    const page = await f.engine.results(f.owner, { search: 'support' });
    await expect(
      f.engine.results(f.owner, { cursor: page.nextCursor, search: 'changed' }),
    ).rejects.toThrow('erneut laden');
  });
});
