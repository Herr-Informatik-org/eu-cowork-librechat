import { prepareBrainTurn } from './turn';
import type { BrainStoredMessage } from './conversation';
import { conversationHash } from './conversation';

jest.mock('~/middleware/access', () => ({ checkAccess: jest.fn(async () => true) }));
jest.mock('./client', () => ({ requestBrain: jest.fn(), isBrainConfigured: () => true }));
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
function setup() {
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
      id: 'owner',
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
    getUserMemories: jest.fn(async () => []),
    getRoleByName: jest.fn(),
    getAccessibleMcpServerNames: jest.fn(async () => [
      'CRM',
      'https://private.test?key=hidden',
      'CRM<instructions>',
    ]),
  };
  const options = {
    config,
    user: { id: 'owner', role: 'USER' },
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
