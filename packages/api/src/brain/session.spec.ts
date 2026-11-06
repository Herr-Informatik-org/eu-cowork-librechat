import { logger } from '@librechat/data-schemas';
import type { BrainCandidate } from './session';
import { createBrainSession, groundedBrainFacts, isBrainChatEligible } from './session';
import { brainRecallTimeoutMs } from './client';
import { attachBrainTools } from './runtime';

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
  describe('chat recall deadline and timing', () => {
    const recallResponse = () =>
      new Response(
        JSON.stringify({
          context: 'Relevante Erinnerung',
          nodes: [{ id: 'node-a' }, { id: 'node-b' }],
          edges: [],
          recall: {},
          hasMore: false,
          suggestedIds: [],
          stopReason: 'fertig',
        }),
        { status: 200 },
      );
    const recallSession = () =>
      createBrainSession({
        userId: 'owner-secret-id',
        conversationId: 'conversation',
        messageId: 'response',
        source,
        recallQuery: 'Vertrauliche Suchanfrage',
        contextBudgetTokens: 10000,
        canWrite: false,
        canUpdate: false,
        countTokens: async (text) => text.length,
      });
    const timingLines = (spy: jest.SpyInstance) =>
      spy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('Abrufdauer'));
    afterEach(() => {
      delete process.env.BRAIN_RECALL_TIMEOUT_MS;
    });

    it.each([
      [undefined, 1500],
      ['800', 800],
      ['50', 300],
      ['999999', 10000],
      ['0', 1500],
      ['kein Wert', 1500],
    ])('bounds BRAIN_RECALL_TIMEOUT_MS=%s to %i ms', (configured, expected) => {
      if (configured !== undefined) process.env.BRAIN_RECALL_TIMEOUT_MS = configured;
      expect(brainRecallTimeoutMs()).toBe(expected);
    });

    it('uses the short recall deadline for the initial recall and brain_search', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      jest.spyOn(global, 'fetch').mockImplementation(async () => recallResponse());
      const session = recallSession();
      await session.initialize();
      await session.tools[0].invoke({ query: 'Präferenz', seedIds: [] });
      expect(timeoutSpy.mock.calls).toEqual([[1500], [1500]]);
    });

    it('keeps the regular deadline and no timing line for background history sessions', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      jest.spyOn(global, 'fetch').mockImplementation(async () => recallResponse());
      const session = createBrainSession({
        userId: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        source,
        historical: true,
        contextBudgetTokens: 10000,
        canWrite: false,
        canUpdate: false,
        countTokens: async (text) => text.length,
      });
      await session.tools[0].invoke({ query: 'Präferenz', seedIds: [] });
      expect(timeoutSpy.mock.calls).toEqual([[5000]]);
      expect(timingLines(infoSpy)).toEqual([]);
    });

    it('logs duration, outcome and node count without query text or ids', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      jest.spyOn(global, 'fetch').mockImplementation(async () => recallResponse());
      const session = recallSession();
      expect(await session.initialize()).toContain('Relevante Erinnerung');
      const [line] = timingLines(infoSpy);
      const timing = JSON.parse(line.slice(line.indexOf('{'))) as {
        phase: string;
        outcome: string;
        durationMs: number;
        nodes: number;
      };
      expect(timing).toMatchObject({ phase: 'initial', outcome: 'ok', nodes: 2 });
      expect(typeof timing.durationMs).toBe('number');
      expect(line).not.toMatch(/Vertrauliche|owner-secret-id|node-a|conversation/);
    });

    it('reports a timeout distinctly and rejects so the caller keeps its fallback', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new DOMException('Synthetic deadline', 'TimeoutError'));
      const session = recallSession();
      await expect(session.initialize()).rejects.toMatchObject({ name: 'BrainServiceError' });
      expect(session.context).toBe('');
      expect(timingLines(infoSpy)).toEqual([expect.stringContaining('"outcome":"timeout"')]);
    });

    it('distinguishes service errors and skipped recalls', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status: 503 }));
      const session = recallSession();
      await expect(session.initialize()).rejects.toMatchObject({ name: 'BrainServiceError' });
      session.setContextBudget(0);
      await session.tools[0].invoke({ query: 'Präferenz', seedIds: [] });
      expect(timingLines(infoSpy)).toEqual([
        expect.stringContaining('"outcome":"error"'),
        expect.stringContaining('"phase":"search","outcome":"skipped"'),
      ]);
    });
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
