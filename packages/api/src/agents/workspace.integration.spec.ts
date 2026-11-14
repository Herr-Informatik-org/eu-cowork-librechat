import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  pageWorkOutput,
  readWorkOutput,
  saveWorkOutput,
  saveCustomerCheckpoint,
  WORK_OUTPUTS,
  WORK_CUSTOMERS,
  compactWorkHistory,
  covered,
} from './workspace';
import { safeWorkDependencies, runVerifiedOdooUpdate, SAFE_WORK_RECORDS } from './safeWork';
import type { SafeWorkScope, SafeWriteDependencies } from './safeWork';
import type { TMessage } from 'librechat-data-provider';

let server: MongoMemoryServer;
let deps: SafeWriteDependencies;
const scope: SafeWorkScope = {
  userId: 'user-a',
  tenantId: 'cw01',
  conversationId: 'chat-a',
  taskId: 'task-a',
};
const beforeFlag = process.env.KISUNO_CWV01_SAFE_WORK;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'work_workspace_test' });
  process.env.KISUNO_WORK_SECRET = randomBytes(32).toString('hex');
  deps = safeWorkDependencies();
}, 60000);
beforeEach(async () => {
  process.env.KISUNO_CWV01_SAFE_WORK = 'true';
  await deps.db
    .collection('conversations')
    .updateOne(
      { user: scope.userId, conversationId: scope.conversationId },
      { $set: { expiredAt: null } },
      { upsert: true },
    );
  await Promise.all(
    [WORK_OUTPUTS, WORK_CUSTOMERS, SAFE_WORK_RECORDS].map((name) =>
      deps.db.collection(name).deleteMany({}),
    ),
  );
});
afterAll(async () => {
  if (beforeFlag == null) delete process.env.KISUNO_CWV01_SAFE_WORK;
  else process.env.KISUNO_CWV01_SAFE_WORK = beforeFlag;
  await mongoose.disconnect();
  await server.stop();
});
it('recovers every character of 79 long ticket descriptions through bounded pages', async () => {
  const content = JSON.stringify({
    records: Array.from({ length: 79 }, (_, id) => ({
      id: id + 1,
      description: 'Vollständige historische Beschreibung. '.repeat(100),
    })),
  });
  const [first] = await pageWorkOutput(scope, 'search-tickets', [content, []], deps);
  let result = JSON.parse(first),
    reconstructed = result.content;
  expect(result.fullyRead).toBe(false);
  while (result.nextOffset != null) {
    result = JSON.parse(
      await readWorkOutput(scope, result.reference, result.nextOffset, 12000, deps),
    );
    reconstructed += result.content;
  }
  expect(result.fullyRead).toBe(true);
  expect(reconstructed).toBe(content);
  const stored = await deps.db.collection(WORK_OUTPUTS).findOne({});
  expect(JSON.stringify(stored)).not.toContain('Vollständige historische Beschreibung');
});
it('prevents a customer completion before all declared historical sources have been read', async () => {
  const reference = await saveWorkOutput(scope, 'long-description', 'X'.repeat(20000), deps);
  const checkpoint = {
    customerId: 42,
    status: 'completed' as const,
    summary: 'Quellenprüfung',
    records: [],
    references: [reference],
  };
  await readWorkOutput(scope, reference, 0, 12000, deps);
  await expect(saveCustomerCheckpoint(scope, checkpoint, deps)).rejects.toThrow('vollständig');
  await readWorkOutput(scope, reference, 12000, 12000, deps);
  await expect(saveCustomerCheckpoint(scope, checkpoint, deps)).resolves.toContain(
    '"verified":true',
  );
});
it('never labels an upstream-truncated source complete, even after reading every stored character', async () => {
  const ref = await saveWorkOutput(scope, 'truncated-description', 'Kurztext [truncated]', deps);
  expect(JSON.parse(await readWorkOutput(scope, ref, 0, 12000, deps)).fullyRead).toBe(false);
  await expect(
    saveCustomerCheckpoint(
      scope,
      {
        customerId: 1,
        status: 'completed',
        summary: 'Unvollständig',
        records: [],
        references: [ref],
      },
      deps,
    ),
  ).rejects.toThrow();
});
it('isolates archived tool outputs by user, tenant and conversation', async () => {
  const ref = await saveWorkOutput(scope, 'source', 'Privater Quellenstand', deps);
  for (const other of [
    { ...scope, userId: 'other' },
    { ...scope, tenantId: 'other' },
    { ...scope, conversationId: 'other' },
  ]) {
    await expect(readWorkOutput(other, ref, 0, 12000, deps)).rejects.toThrow();
  }
});
it('requires verified per-record writes for claimed modified rows', async () => {
  const checkpoint = {
    customerId: 42,
    status: 'completed' as const,
    summary: 'Einzelprüfung',
    records: [{ model: 'account.analytic.line', id: 7 }],
    references: [],
  };
  await expect(saveCustomerCheckpoint(scope, checkpoint, deps)).rejects.toThrow(
    'Rücklesekontrolle',
  );
  let validated = false;
  await runVerifiedOdooUpdate(
    {
      scope,
      serverName: 'odoo-administrator',
      input: { model: 'account.analytic.line', record_id: 7, values: { validated: true } },
      read: async () => [JSON.stringify({ record: { id: 7, validated } }), []],
      write: async () => {
        validated = true;
      },
    },
    deps,
  );
  await expect(saveCustomerCheckpoint(scope, checkpoint, deps)).resolves.toContain(
    '"verified":true',
  );
});
it('preserves a long chat and its write receipts while compacting only old read outputs', async () => {
  const checkpoint = await saveCustomerCheckpoint(
    scope,
    {
      customerId: 42,
      status: 'completed',
      summary: 'Geprüfte Arbeit',
      records: [],
      references: [],
    },
    deps,
  );
  const part = (name: string, output: string) => ({
    type: 'tool_call',
    tool_call: { name, id: name, output },
  });
  const messages = [
    {
      messageId: 'user-rule',
      isCreatedByUser: true,
      content: [{ type: 'text', text: 'Alle Zeilen einzeln prüfen. Kundenname nie in den Titel.' }],
    },
    {
      messageId: 'old-customer',
      isCreatedByUser: false,
      content: [
        part('get_record_mcp_odoo-administrator', 'Historische Daten. '.repeat(400)),
        part('update_record_mcp_odoo-administrator', '{"verified":true}'),
      ],
    },
    {
      messageId: 'boundary',
      isCreatedByUser: false,
      content: [part('arbeitsstand_sichern', checkpoint)],
    },
    {
      messageId: 'active-customer',
      isCreatedByUser: false,
      content: [part('get_record_mcp_odoo-administrator', 'Aktueller Kunde. '.repeat(400))],
    },
  ] as Array<Pick<TMessage, 'messageId' | 'content' | 'isCreatedByUser'>>;
  const original = JSON.stringify(messages);
  const compacted = await compactWorkHistory(messages, scope, deps);
  expect(compacted[0]).toEqual(messages[0]);
  expect(compacted[3]).toEqual(messages[3]);
  expect(compacted[1].content?.[1]).toEqual(messages[1].content?.[1]);
  expect(JSON.stringify(compacted[1])).not.toContain('Historische Daten. Historische');
  expect(JSON.stringify(messages)).toBe(original);
  expect(JSON.stringify(compacted).length).toBeLessThan(original.length * 0.7);
});
it('does not compact without a confirmed customer boundary or when CWV01 mode is off', async () => {
  const messages = [{ messageId: 'old', isCreatedByUser: false, content: [] }];
  expect(await compactWorkHistory(messages, scope, deps)).toBe(messages);
  delete process.env.KISUNO_CWV01_SAFE_WORK;
  expect(await compactWorkHistory(messages, scope, deps)).toBe(messages);
});
it('detects gaps and overlapping ranges correctly', () => {
  expect(
    covered(
      [
        { start: 0, end: 5 },
        { start: 6, end: 10 },
      ],
      10,
    ),
  ).toBe(false);
  expect(
    covered(
      [
        { start: 4, end: 10 },
        { start: 0, end: 5 },
      ],
      10,
    ),
  ).toBe(true);
});

it('keeps distinct snapshots when an identical query sees a changed live record', async () => {
  const first = await saveWorkOutput(scope, 'same-query', 'Bisheriger Inhalt', deps);
  const next = await saveWorkOutput(scope, 'same-query', 'Neuer Inhalt', deps);
  expect(next).not.toBe(first);
  expect(JSON.parse(await readWorkOutput(scope, next, 0, 12000, deps)).content).toBe(
    'Neuer Inhalt',
  );
});
