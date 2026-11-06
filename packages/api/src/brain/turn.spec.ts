import type { BrainStoredMessage } from './conversation';
import { legacyMemoryFingerprint } from './legacy';
import { conversationHash } from './conversation';
import { prepareBrainTurn } from './turn';
import { requestBrain } from './client';

jest.mock('~/middleware/access', () => ({ checkAccess: jest.fn(async () => true) }));
jest.mock('./client', () => ({
  requestBrain: jest.fn(),
  isBrainConfigured: () => true,
  isBrainTimeout: () => false,
  brainRecallTimeoutMs: () => 1500,
}));
const records: BrainStoredMessage[] = [
  {
    conversationId: 'conversation',
    messageId: 'u1',
    text: 'Plane Atlas.',
    isCreatedByUser: true,
    createdAt: '2026-09-14T12:00:00Z',
  },
  {
    conversationId: 'conversation',
    messageId: 'a1',
    parentMessageId: 'u1',
    text: 'Für Atlas ist die EU-Region möglich.',
    isCreatedByUser: false,
    createdAt: '2026-09-14T12:01:00Z',
  },
  {
    conversationId: 'conversation',
    messageId: 'a2',
    parentMessageId: 'u1',
    text: 'Sibling proposal',
    isCreatedByUser: false,
    createdAt: '2026-09-14T12:01:01Z',
  },
  {
    conversationId: 'conversation',
    messageId: 'u2',
    parentMessageId: 'a1',
    text: 'Ja, das ist wichtig.',
    isCreatedByUser: true,
    createdAt: '2026-09-14T12:02:00Z',
  },
];
type Options = Parameters<typeof prepareBrainTurn>[0];
interface LegacyMemoryFixture {
  key: string;
  value: string;
  updated_at?: Date;
  agentId?: string;
}
function setup(userId = 'owner') {
  const stored = structuredClone(records);
  let config = {
    memory: {
      organizationContext: { text: 'IT-Dienstleister', version: 'v1' },
      useMcpContext: true,
    },
  };
  let enabled = true;
  const dependencies = {
    getUserById: jest.fn(async () => ({
      id: userId,
      role: 'USER',
      personalization: { memories: enabled },
    })),
    getMessages: jest.fn(async (filter: { messageId?: string }) =>
      filter.messageId
        ? stored.filter((message) => message.messageId === filter.messageId)
        : stored,
    ),
    getConvo: jest.fn(async () => ({ conversationId: 'conversation' })),
    getAppConfig: jest.fn(async () => config),
    getUserMemories: jest.fn(async (): Promise<LegacyMemoryFixture[]> => []),
    getRoleByName: jest.fn(),
    getAccessibleMcpServerNames: jest.fn(async () => [
      'CRM',
      'https://private.test?key=hidden',
      'CRM<instructions>',
    ]),
  };
  const options = {
    config,
    user: { id: userId, role: 'USER' },
    conversationId: 'conversation',
    messageId: 'response',
    sourceMessage: stored[3],
    dependencies,
  } as unknown as Options;
  return {
    options,
    dependencies,
    edit() {
      stored[1].text = 'Changed proposal';
    },
    append() {
      stored.push({ ...stored[3], messageId: 'new-user', parentMessageId: 'u2' });
    },
    optOut() {
      enabled = false;
    },
    configure() {
      config = {
        ...config,
        memory: { ...config.memory, organizationContext: { text: 'changed', version: 'v2' } },
      };
    },
  };
}

describe('ongoing conversation ownership and freshness', () => {
  it('loads only the selected parent branch and sanitized opted-in connection names', async () => {
    const state = setup();
    const { session } = await prepareBrainTurn(state.options);
    const messages = await session!.options.loadConversation!();
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
    expect(session!.options.connectionHints).toEqual(['CRM']);
    expect(messages[1].contentHash).toBe(conversationHash(records[1].text!));
    expect(state.dependencies.getConvo).toHaveBeenCalledWith('owner', 'conversation');
    expect(state.dependencies.getMessages).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'conversation',
    });
    expect(await session!.options.authorizeConversation!(messages)).toBe(true);
    expect(state.dependencies.getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
    );
  });
  it.each(['edit', 'append', 'optOut', 'configure'] as const)(
    'refuses persistence after %s',
    async (change) => {
      const state = setup();
      const { session } = await prepareBrainTurn(state.options);
      const messages = await session!.options.loadConversation!();
      state[change]();
      expect(await session!.options.authorizeConversation!(messages)).toBe(false);
    },
  );
  it('coalesces overlapping turns without cancelling other owners', async () => {
    const first = await prepareBrainTurn(setup().options);
    const next = await prepareBrainTurn(setup().options);
    expect(first.session!.options.signal?.aborted).toBe(true);
    expect(next.session!.options.signal?.aborted).toBe(false);
  });
});

describe('legacy memory import off the critical path', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const updatedAt = new Date('2026-09-01T00:00:00.000Z');
  const legacy = (value = 'Ich arbeite mit Atlas.'): LegacyMemoryFixture[] => [
    { key: 'arbeitsweise', value, updated_at: updatedAt },
    { key: 'agent', value: 'Agentenspeicher', agentId: 'agent-1' },
  ];
  const importCalls = () =>
    jest.mocked(requestBrain).mock.calls.filter(([, , path]) => path === '/v1/import');
  beforeEach(() => {
    jest.mocked(requestBrain).mockReset();
  });

  it('does not await the import and imports an unchanged legacy state only once', async () => {
    const state = setup('legacy-once');
    state.dependencies.getUserMemories.mockImplementation(async () => legacy());
    let release: (() => void) | undefined;
    jest.mocked(requestBrain).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ nodes: [], skipped: 0 });
        }),
    );
    const prepared = await prepareBrainTurn(state.options);
    expect(prepared.session).toBeDefined();
    expect(prepared.context).toBeUndefined();
    await flush();
    expect(importCalls()).toEqual([
      [
        'legacy-once',
        'POST',
        '/v1/import',
        { memories: [{ key: 'arbeitsweise', value: 'Ich arbeite mit Atlas.', updatedAt }] },
        30000,
      ],
    ]);

    await prepareBrainTurn(state.options);
    await flush();
    expect(importCalls()).toHaveLength(1);

    release?.();
    await flush();
    await prepareBrainTurn(state.options);
    await flush();
    expect(importCalls()).toHaveLength(1);

    state.dependencies.getUserMemories.mockImplementation(async () =>
      legacy('Ich arbeite mit Zeus.'),
    );
    await prepareBrainTurn(state.options);
    await flush();
    release?.();
    expect(importCalls()).toHaveLength(2);
  });

  it('reports a failed import without failing the turn and retries on the next turn', async () => {
    const state = setup('legacy-retry');
    const reportFailure = jest.fn(async () => undefined);
    state.dependencies.getUserMemories.mockImplementation(async () => legacy());
    jest
      .mocked(requestBrain)
      .mockRejectedValueOnce(new Error('Synthetic outage'))
      .mockResolvedValue({ nodes: [], skipped: 0 });
    const prepared = await prepareBrainTurn({ ...state.options, reportFailure });
    expect(prepared.context).toBeUndefined();
    await flush();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'legacy-retry', operation: 'recall', stage: 'ingest' }),
    );
    await prepareBrainTurn({ ...state.options, reportFailure });
    await flush();
    await prepareBrainTurn({ ...state.options, reportFailure });
    await flush();
    expect(importCalls()).toHaveLength(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });

  it('fingerprints key, date and value independently of order', () => {
    const [personal] = legacy();
    const later = { ...personal, updated_at: new Date('2026-09-02T00:00:00.000Z') };
    const other = { key: 'stil', value: 'Kurz antworten.' };
    const base = legacyMemoryFingerprint([personal, other]);
    expect(legacyMemoryFingerprint([other, personal])).toBe(base);
    expect(legacyMemoryFingerprint([later, other])).not.toBe(base);
    expect(legacyMemoryFingerprint([{ ...personal, value: 'Anders.' }, other])).not.toBe(base);
    expect(legacyMemoryFingerprint([{ ...personal, key: 'neu' }, other])).not.toBe(base);
    expect(base).not.toContain('Atlas');
  });
});
