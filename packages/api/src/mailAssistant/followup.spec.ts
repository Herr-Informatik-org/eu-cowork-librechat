import type { Collection } from 'mongodb';
import type { MailAssistantEngine, MailRuntimeAdapter, MailStore, StoredMailResult } from './types';
import type { FollowupOdoo, OdooRecord } from './followupMcp';
import type { FollowupRow } from './followup';
import { createMailFollowup } from './followup';
import { createMailCodec } from './privateData';
import { resultRevision } from './engine';
import { MAIL_CONSENT_VERSION } from './types';

const owner = 'a'.repeat(24);
const result: StoredMailResult = {
  id: 'mail-1',
  messageId: 'immutable-mail-1',
  conversationId: 'thread-1',
  sourceHash: 'source',
  subject: 'Server Backup',
  sender: 'customer@example.test',
  receivedAt: '2026-10-27T09:00:00Z',
  priority: 'normal',
  action: 'review',
  summary: 'Anfrage',
  reason: 'Offen',
  questions: [],
  draftStatus: 'none',
  categoryApplied: true,
};
function fixture() {
  const rows = new Map<string, FollowupRow>();
  const matches = (row: FollowupRow, query: Record<string, unknown>) =>
    Object.entries(query).every(
      ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
    );
  const collection = {
    createIndex: jest.fn(async () => 'fixture'),
    findOne: jest.fn(
      async (query) => [...rows.values()].find((row) => matches(row, query)) ?? null,
    ),
    insertOne: jest.fn(async (row: FollowupRow) => {
      if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      rows.set(row._id, structuredClone(row));
      return { acknowledged: true };
    }),
    updateOne: jest.fn(async (query, update, options) => {
      const saved = [...rows.values()].find((row) => matches(row, query));
      if (!saved && !options?.upsert) return { matchedCount: 0 };
      const next = { ...(saved ?? query), ...update.$set };
      rows.set(next._id, next);
      return { matchedCount: saved ? 1 : 0 };
    }),
    deleteMany: jest.fn(async (query) => {
      for (const [key, row] of rows) if (matches(row, query)) rows.delete(key);
    }),
  };
  const state = {
    now: new Date('2026-10-27T10:00:00Z'),
    generation: 'generation-1',
    revision: 1,
    projectVisibility: 'employees',
    users: [
      {
        id: 7,
        name: 'Person',
        email: 'person@example.test',
        login: 'person@example.test',
        share: false,
        active: true,
      },
    ],
    tasks: [] as OdooRecord[],
  };
  const odoo: FollowupOdoo = {
    writeCapability: jest.fn(async () => ({ available: true })),
    search: jest.fn(async (model) => {
      if (model === 'res.users') return state.users;
      if (model === 'res.partner')
        return [
          { id: 11, email: 'customer@example.test', commercial_partner_id: [11, 'Customer'] },
        ];
      if (model === 'project.project')
        return [{ id: 22, name: 'GL', privacy_visibility: state.projectVisibility, active: true }];
      return state.tasks;
    }),
    get: jest.fn(async (model, id) =>
      model === 'project.project'
        ? { id, name: 'GL', privacy_visibility: state.projectVisibility, active: true }
        : state.tasks.find((task) => task.id === id)!,
    ),
    create: jest.fn(async () => 99),
    note: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
  };
  const identity = jest.fn(async () => ({
    id: owner,
    role: 'USER',
    email: 'person@example.test',
    profiles: ['odoo-technik' as const],
  }));
  const store = {
    read: jest.fn(async () => ({
      revision: state.revision,
      settings: { consentVersion: MAIL_CONSENT_VERSION },
    })),
    result: jest.fn(async () => result),
  } as unknown as MailStore;
  const adapter = {
    connection: jest.fn(async () => ({
      connected: true,
      mailbox: 'person@example.test',
      generation: state.generation,
    })),
    audit: jest.fn(async () => undefined),
  } as unknown as MailRuntimeAdapter;
  const engine = {
    content: jest.fn(async () => ({
      message: {
        subject: 'Server Backup',
        sender: 'customer@example.test',
        receivedAt: result.receivedAt,
        body: '<script>alert(1)</script> Private Nachricht',
        bodyTruncated: false,
      },
    })),
  } as unknown as MailAssistantEngine;
  const open = jest.fn(async () => odoo);
  const service = createMailFollowup({
    collection: () => collection as unknown as Collection<FollowupRow>,
    codec: createMailCodec('4'.repeat(64)),
    store,
    adapter,
    engine,
    identity,
    open,
    profiles: async () => [{ id: 'odoo-technik', label: 'Technik' }],
    now: () => state.now,
  });
  const settings = () =>
    service.saveSettings(owner, { profile: 'odoo-technik', mode: 'project', projectId: 22 });
  const prepare = async () => {
    const preview = await service.prepare(owner, result.id, { revision: resultRevision(result) });
    if (!('token' in preview)) throw new Error('no preview');
    return preview;
  };
  return {
    service,
    rows,
    collection,
    state,
    odoo,
    identity,
    store,
    adapter,
    engine,
    open,
    settings,
    prepare,
  };
}
describe('personal mail follow-up', () => {
  it('verifies the assigned internal user and target without writing Odoo', async () => {
    const f = fixture();
    expect(await f.settings()).toMatchObject({ userId: 7, projectId: 22, projectName: 'GL' });
    expect(f.odoo.create).not.toHaveBeenCalled();
    expect(f.odoo.note).not.toHaveBeenCalled();
    expect(JSON.stringify([...f.rows.values()])).not.toContain('Person');
  });
  it.each(['portal', 'unknown'])(
    'rejects externally visible or unknown project visibility %s',
    async (value) => {
      const f = fixture();
      f.state.projectVisibility = value;
      await expect(f.settings()).rejects.toThrow('extern');
      expect(f.rows.size).toBe(0);
    },
  );
  it('does not map a shared or ambiguous Odoo user to personal To-dos', async () => {
    const f = fixture();
    f.state.users[0].share = true;
    await expect(f.settings()).rejects.toThrow('eindeutigen');
    f.state.users[0].share = false;
    f.state.users.push({ ...f.state.users[0], id: 8 });
    await expect(f.settings()).rejects.toThrow('eindeutigen');
  });
  it('does not accept arbitrary profile, URL or a project for private To-dos', async () => {
    const f = fixture();
    await expect(
      f.service.saveSettings(owner, { profile: 'http://attacker', mode: 'todo' }),
    ).rejects.toThrow();
    await expect(
      f.service.saveSettings(owner, { profile: 'odoo-technik', mode: 'todo', projectId: 22 }),
    ).rejects.toThrow();
  });
  it('prepares an encrypted expiring preview and passes mail only as data to the safe task tool', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    expect(preview.targetLabel).toBe('GL');
    expect(preview.body).toContain('Private Nachricht');
    expect(JSON.stringify([...f.rows.values()])).not.toContain('Private Nachricht');
    expect(f.odoo.create).not.toHaveBeenCalled();
    expect(await f.service.commit(owner, { token: preview.token })).toMatchObject({
      status: 'completed',
      taskId: 99,
      action: 'created',
    });
    expect(f.odoo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeId: 7,
        projectId: 22,
        body: expect.stringContaining('<script>'),
        operationKey: expect.stringMatching(/^operation:[a-f0-9]{64}$/),
      }),
    );
  });
  it('keeps preparation readable but fails closed before reserving or writing without safe bridge capability', async () => {
    const f = fixture();
    await f.settings();
    jest
      .mocked(f.odoo.writeCapability)
      .mockResolvedValue({ available: false, reason: 'Sichere Brücke fehlt.' });
    const preview = await f.prepare();
    expect(preview).toMatchObject({ writeAvailable: false, writeReason: 'Sichere Brücke fehlt.' });
    await expect(f.service.commit(owner, { token: preview.token })).rejects.toThrow(
      'Sichere Brücke fehlt',
    );
    expect([...f.rows.values()].some((row) => row.kind === 'operation')).toBe(false);
    expect(f.odoo.create).not.toHaveBeenCalled();
    expect(f.odoo.note).not.toHaveBeenCalled();
  });
  it('uses a verified personal To-do assignee and no project', async () => {
    const f = fixture();
    await f.service.saveSettings(owner, { profile: 'odoo-technik', mode: 'todo' });
    const preview = await f.prepare();
    await f.service.commit(owner, { token: preview.token });
    expect(f.odoo.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined, assigneeId: 7 }),
    );
  });
  it('proposes same-customer/topic candidates and appends only to explicitly chosen candidate', async () => {
    const f = fixture();
    await f.settings();
    f.state.tasks = [
      {
        id: 44,
        name: 'Server Backup',
        project_id: [22, 'GL'],
        user_ids: [7],
        partner_id: [11, 'Customer'],
        active: true,
        state: '01_in_progress',
        description: '',
      },
    ];
    const preview = await f.prepare();
    expect(preview.candidates).toEqual([{ id: 44, name: 'Server Backup', customer: 'Customer' }]);
    await expect(f.service.commit(owner, { token: preview.token, taskId: 45 })).rejects.toThrow(
      'geprüften',
    );
    const receipt = await f.service.commit(owner, { token: preview.token, taskId: 44 });
    expect(receipt).toMatchObject({ action: 'appended', taskId: 44 });
    expect(f.odoo.note).toHaveBeenCalledWith(
      44,
      preview.body,
      expect.stringMatching(/^operation:[a-f0-9]{64}$/),
    );
    expect(f.odoo.create).not.toHaveBeenCalled();
  });
  it('rejects a candidate whose customer or project changed after preview', async () => {
    const f = fixture();
    await f.settings();
    f.state.tasks = [
      {
        id: 44,
        name: 'Server Backup',
        project_id: [22, 'GL'],
        user_ids: [7],
        partner_id: [11, 'Customer'],
        active: true,
        state: '01_in_progress',
        description: '',
      },
    ];
    const preview = await f.prepare();
    f.state.tasks[0].partner_id = [33, 'Another Customer'];
    await expect(f.service.commit(owner, { token: preview.token, taskId: 44 })).rejects.toThrow(
      'verändert',
    );
    expect(f.odoo.note).not.toHaveBeenCalled();
  });
  it.each(['generation', 'revision'])(
    'rejects changed mail binding %s before writing',
    async (field) => {
      const f = fixture();
      await f.settings();
      const preview = await f.prepare();
      if (field === 'generation') f.state.generation = 'changed';
      else f.state.revision++;
      await expect(f.service.commit(owner, { token: preview.token })).rejects.toThrow('verändert');
      expect(f.odoo.create).not.toHaveBeenCalled();
    },
  );
  it('rejects expired previews', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    f.state.now = new Date(f.state.now.getTime() + 11 * 60000);
    await expect(f.service.commit(owner, { token: preview.token })).rejects.toThrow('abgelaufen');
    expect(f.odoo.create).not.toHaveBeenCalled();
  });
  it('deduplicates different previews and concurrent double clicks per immutable mail', async () => {
    const f = fixture();
    await f.settings();
    const first = await f.prepare();
    const second = await f.prepare();
    await Promise.all([
      f.service.commit(owner, { token: first.token }),
      f.service.commit(owner, { token: second.token }),
    ]);
    expect(f.odoo.create).toHaveBeenCalledTimes(1);
    const replay = await f.service.prepare(owner, result.id, { revision: resultRevision(result) });
    expect(replay).toMatchObject({ existing: { status: 'completed', taskId: 99 } });
  });
  it('never replays an uncertain external write even after reconnect', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    jest.mocked(f.odoo.create).mockRejectedValueOnce(new Error('timeout after commit'));
    expect(await f.service.commit(owner, { token: preview.token })).toEqual({
      status: 'uncertain',
    });
    f.state.generation = 'reconnected';
    expect(await f.service.prepare(owner, result.id, { revision: resultRevision(result) })).toEqual(
      { existing: { status: 'uncertain' } },
    );
    expect(f.odoo.create).toHaveBeenCalledTimes(1);
  });
  it('does not write without successful audit', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    jest.mocked(f.adapter.audit).mockRejectedValueOnce(new Error('audit down'));
    await expect(f.service.commit(owner, { token: preview.token })).rejects.toThrow('audit');
    expect(f.odoo.create).not.toHaveBeenCalled();
  });
  it('rechecks the recorded profile before showing existing receipts', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    await f.service.commit(owner, { token: preview.token });
    f.open.mockRejectedValueOnce(new Error('profile revoked'));
    await expect(
      f.service.prepare(owner, result.id, { revision: resultRevision(result) }),
    ).rejects.toThrow('revoked');
  });
  it('does not start an external write after its durable reservation disappeared', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    const original = f.collection.updateOne.getMockImplementation()!;
    f.collection.updateOne.mockImplementation(async (query, update, options) =>
      update.$set.externalStarted ? { matchedCount: 0 } : original(query, update, options),
    );
    expect(await f.service.commit(owner, { token: preview.token })).toEqual({
      status: 'uncertain',
    });
    expect(f.odoo.create).not.toHaveBeenCalled();
  });
  it('clears previews on disconnect but preserves uncertain/completed dedup records', async () => {
    const f = fixture();
    await f.settings();
    const preview = await f.prepare();
    await f.service.commit(owner, { token: preview.token });
    await f.service.clearPreviews(owner);
    expect([...f.rows.values()].some((r) => r.kind === 'preview')).toBe(false);
    expect([...f.rows.values()].some((r) => r.kind === 'operation')).toBe(true);
  });
});
