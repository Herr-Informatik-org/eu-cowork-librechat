import { createBrainSession, groundedBrainFacts, isBrainChatEligible } from './session';
import { attachBrainTools } from './runtime';
import type { BrainCandidate } from './session';

const source = {
  id: 'message-1',
  text: 'Ich bevorzuge kurze Antworten. Vergiss die alte Präferenz.',
  createdAt: '2026-09-14T12:00:00.000Z',
};
const candidate: BrainCandidate = {
  quote: 'Ich bevorzuge kurze Antworten.',
  kind: 'preference',
  tags: [],
  relatedIds: [],
};

describe('personal Brain scope and grounding', () => {
  beforeEach(() => {
    process.env.BRAIN_API_URL = 'http://brain.invalid';
    process.env.BRAIN_SHARED_SECRET = 'synthetic-test-key';
    delete process.env.BRAIN_ENABLED;
  });
  afterEach(() => {
    delete process.env.BRAIN_API_URL;
    delete process.env.BRAIN_SHARED_SECRET;
    delete process.env.BRAIN_ENABLED;
    jest.restoreAllMocks();
  });

  it.each([
    { memoriesEnabled: false },
    { temporary: true },
    { temporary: 'true' },
    { memoryDisabled: true },
  ])('does not activate for %j', (flags) => {
    expect(isBrainChatEligible(flags)).toBe(false);
  });
  it('honours the deployment learning/read switch', () => {
    expect(isBrainChatEligible({})).toBe(true);
    process.env.BRAIN_ENABLED = 'false';
    expect(isBrainChatEligible({})).toBe(false);
  });
  it('rejects invented evidence and unknown supersession targets', () => {
    expect(
      groundedBrainFacts(
        [{ ...candidate, quote: 'Ich bevorzuge lange Antworten.' }],
        source,
        new Set(),
      ),
    ).toEqual([]);
    expect(
      groundedBrainFacts([{ ...candidate, supersedesId: 'other-user-node' }], source, new Set()),
    ).toEqual([]);
    const facts = groundedBrainFacts([candidate], source, new Set());
    expect(facts[0].text).toBe(candidate.quote);
    expect(facts[0].sourceMessageIds).toEqual(['message-1']);
  });
  it('does not persist after a mid-review opt-out', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const session = createBrainSession({
      userId: 'user',
      conversationId: 'conversation',
      messageId: 'response',
      source,
      contextBudgetTokens: 4000,
      canWrite: true,
      canUpdate: true,
      canPersist: async () => false,
    });
    expect(await session.remember([candidate], true)).toMatchObject({ nodes: [], skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('budgets the fully rendered tool result and rejects oversized metadata', async () => {
    const result = {
      context: 'x'.repeat(2000),
      nodes: [{ id: 'node', title: 'x'.repeat(2000) }],
      edges: [],
      recall: {},
      hasMore: false,
      suggestedIds: [],
      stopReason: 'fertig',
    };
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source,
      contextBudgetTokens: 800,
      canWrite: false,
      canUpdate: false,
      countTokens: async (text) => text.length,
    });
    const output = await session.tools[0].invoke({ query: 'Präferenz', seedIds: [] });
    expect(String(output).length).toBeLessThanOrEqual(800);
    expect(String(output)).not.toContain('x'.repeat(100));
    expect(session.knownIds.size).toBe(0);
  });
  it('retains a large fitting recall without escaping or duplicating its source text', async () => {
    const context = 'Projekt \"Atlas\"\n'.repeat(1000);
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          context,
          nodes: [{ id: 'node', title: 'Atlas' }],
          edges: [],
          recall: {},
          hasMore: false,
          suggestedIds: [],
          stopReason: 'fertig',
        }),
        { status: 200 },
      ),
    );
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source,
      contextBudgetTokens: context.length + 512,
      canWrite: false,
      canUpdate: false,
      countTokens: async (text) => text.length,
    });
    const output = String(await session.tools[0].invoke({ query: 'Atlas', seedIds: [] }));
    expect(output.startsWith(context)).toBe(true);
    expect(output.length).toBeLessThanOrEqual(context.length + 512);
    expect(session.knownIds.has('node')).toBe(true);
  });
  it('subtracts exact output until a fresh live context snapshot arrives', async () => {
    const requests: { contextBudgetTokens: number }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, request) => {
      requests.push(JSON.parse(String(request?.body)) as { contextBudgetTokens: number });
      return new Response(
        JSON.stringify({
          context: 'Relevante Erinnerung',
          nodes: [],
          edges: [],
          recall: {},
          hasMore: false,
          suggestedIds: [],
          stopReason: 'fertig',
        }),
        { status: 200 },
      );
    });
    let revision = 1;
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source,
      contextBudgetTokens: 10000,
      canWrite: false,
      canUpdate: false,
      getBudget: () => ({ remaining: 2000, revision }),
      countTokens: async (text) => text.length,
    });
    const first = String(await session.tools[0].invoke({ query: 'Präferenz', seedIds: [] }));
    await session.tools[0].invoke({ query: 'Entscheidung', seedIds: [] });
    expect(requests[0].contextBudgetTokens - requests[1].contextBudgetTokens).toBe(first.length);
    revision = 2;
    await session.tools[0].invoke({ query: 'Projekt', seedIds: [] });
    expect(requests[2].contextBudgetTokens).toBe(requests[0].contextBudgetTokens);
  });
  it('replaces legacy writes without mutating the shared tool registry', () => {
    const original = new Map([
      [
        'set_memory',
        { name: 'set_memory', description: 'legacy', parameters: { type: 'object' as const } },
      ],
    ]);
    const agent = {
      tools: ['memory'],
      toolRegistry: original,
      toolDefinitions: [...original.values()],
      memoryToolsRegistered: true,
    };
    attachBrainTools(agent);
    expect(agent.tools).toEqual([]);
    expect(agent.toolRegistry.has('set_memory')).toBe(false);
    expect(original.has('set_memory')).toBe(true);
    expect(agent.memoryToolsRegistered).toBe(false);
  });
});
