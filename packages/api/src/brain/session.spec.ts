import { logger } from '@librechat/data-schemas';
import type { BrainCandidate, BrainSessionOptions } from './session';
import type { BrainConversationMessage } from './conversation';
import {
  createBrainSession,
  groundedBrainFacts,
  isBrainChatEligible,
  brainRecallLimitTokens,
} from './session';
import { conversationHash } from './conversation';
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
    const context = 'Projekt "Atlas"\n'.repeat(1000);
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

  describe('explicit remember with conversation context', () => {
    const current = {
      id: 'message-current',
      text: 'Ich schreibe Kundenbriefe immer in der Sie-Form. Mein Stundensatz beträgt 140 Franken. Bitte merke dir das dauerhaft.',
      createdAt: '2026-11-06T09:00:00.000Z',
    };
    const conversation: BrainConversationMessage[] = [
      {
        id: 'message-earlier',
        role: 'user',
        text: 'Wie formuliere ich eine Mahnung?',
        createdAt: '2026-11-06T08:58:00.000Z',
        contentHash: conversationHash('Wie formuliere ich eine Mahnung?'),
      },
      {
        id: 'answer-earlier',
        parentId: 'message-earlier',
        role: 'assistant',
        text: 'Verwenden Sie für Mahnungen immer einen freundlichen, aber bestimmten Ton.',
        createdAt: '2026-11-06T08:59:00.000Z',
        contentHash: conversationHash(
          'Verwenden Sie für Mahnungen immer einen freundlichen, aber bestimmten Ton.',
        ),
      },
      {
        id: current.id,
        parentId: 'answer-earlier',
        role: 'user',
        text: current.text,
        createdAt: current.createdAt,
        contentHash: conversationHash(current.text),
      },
    ];
    interface IngestBody {
      facts: { text: string; evidence?: { messageId: string; quote: string }[] }[];
      sourceMessages: { id: string; text?: string }[];
      explicit?: boolean;
    }
    const ingestRequests = (spy: jest.SpyInstance): IngestBody[] =>
      spy.mock.calls
        .filter(([url]) => String(url).endsWith('/v1/ingest'))
        .map(([, request]) => JSON.parse(String((request as RequestInit).body)) as IngestBody);
    const rememberSession = (overrides: Partial<BrainSessionOptions> = {}) =>
      createBrainSession({
        userId: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        source: current,
        contextBudgetTokens: 4000,
        canWrite: true,
        canUpdate: false,
        loadConversation: async () => conversation,
        authorizeConversation: async () => true,
        ...overrides,
      });
    const stored = () =>
      jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ nodes: [{ id: 'node-new' }], skipped: 0, created: 1 }), {
            status: 200,
          }),
      );
    const styleRule = {
      quote: 'Ich schreibe Kundenbriefe immer in der Sie-Form.',
      text: 'Kundenbriefe werden immer in der Sie-Form geschrieben.',
      kind: 'preference' as const,
      tags: [],
      relatedIds: [],
    };

    it('anchors an invented evidence id to the current message when the quote is verbatim', async () => {
      const fetchSpy = stored();
      const result = await rememberSession().remember([
        {
          ...styleRule,
          evidence: [{ messageId: 'current-user-message', quote: styleRule.quote }],
        },
        {
          quote: 'Mein Stundensatz beträgt 140 Franken.',
          text: 'Der Stundensatz beträgt 140 Franken.',
          kind: 'fact',
          evidence: [{ messageId: 'user-1', quote: 'Mein Stundensatz beträgt 140 Franken.' }],
        },
      ]);
      expect(result.error).toBeUndefined();
      const [body] = ingestRequests(fetchSpy);
      expect(body.explicit).toBe(true);
      expect(body.facts).toHaveLength(2);
      expect(body.facts.flatMap((fact) => fact.evidence?.map((entry) => entry.messageId))).toEqual([
        current.id,
        current.id,
      ]);
      expect(body.sourceMessages.find((message) => message.id === current.id)?.text).toBe(
        current.text,
      );
      expect(
        body.sourceMessages.find((message) => message.id === 'answer-earlier')?.text,
      ).toBeUndefined();
    });

    it('uses the quote as current evidence when text arrives without evidence', async () => {
      const fetchSpy = stored();
      const result = await rememberSession().remember([styleRule]);
      expect(result.error).toBeUndefined();
      expect(ingestRequests(fetchSpy)[0].facts[0].evidence).toEqual([
        { messageId: current.id, quote: styleRule.quote },
      ]);
    });

    it('rejects an invented evidence id whose quote is not in the current message', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const result = await rememberSession().remember([
        {
          ...styleRule,
          quote: 'Ich schreibe Kundenbriefe immer per Du.',
          evidence: [
            { messageId: 'current-user-message', quote: 'Ich schreibe Kundenbriefe immer per Du.' },
          ],
        },
      ]);
      expect(result).toMatchObject({ nodes: [], skipped: 1 });
      expect(result.error).toContain('Keine gültigen Aussagen');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a quote taken from assistant text, also under an invented id', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const assistantQuote =
        'Verwenden Sie für Mahnungen immer einen freundlichen, aber bestimmten Ton.';
      for (const messageId of ['user-1', 'answer-earlier']) {
        const result = await rememberSession().remember([
          {
            quote: assistantQuote,
            text: 'Mahnungen werden freundlich, aber bestimmt formuliert.',
            kind: 'preference',
            evidence: [{ messageId, quote: assistantQuote }],
          },
        ]);
        expect(result.error).toContain('Keine gültigen Aussagen');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('stores direct quotes and contextual statements from one call together', async () => {
      const fetchSpy = stored();
      await rememberSession().remember([
        { quote: 'Mein Stundensatz beträgt 140 Franken.', kind: 'fact' },
        styleRule,
      ]);
      const [body] = ingestRequests(fetchSpy);
      expect(body.facts.map((fact) => fact.text)).toEqual([
        styleRule.text,
        'Mein Stundensatz beträgt 140 Franken.',
      ]);
    });

    it('never stores credentials, even on explicit request', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const session = createBrainSession({
        userId: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        source: { ...current, text: 'Merke dir: Das WLAN-Kennwort lautet Sommer2026!' },
        contextBudgetTokens: 4000,
        canWrite: true,
        canUpdate: false,
      });
      const result = await session.remember([
        { quote: 'Das WLAN-Kennwort lautet Sommer2026!', kind: 'fact' },
      ]);
      expect(result.error).toContain('Keine gültigen Aussagen');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('withholds sensitive candidates from automatic learning but keeps explicit ones', async () => {
      const source = {
        ...current,
        text: 'Bericht für Patientin M., Diagnose Angststörung. IBAN CH93 0076 2011 6238 5295 7.',
      };
      const health = {
        quote: 'Bericht für Patientin M., Diagnose Angststörung.',
        kind: 'fact' as const,
      };
      const iban = { quote: 'IBAN CH93 0076 2011 6238 5295 7.', kind: 'fact' as const };
      const options = {
        userId: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        source,
        contextBudgetTokens: 4000,
        canWrite: true,
        canUpdate: false,
      };
      const fetchSpy = stored();
      expect(await createBrainSession(options).remember([health, iban], true)).toEqual({
        nodes: [],
        skipped: 2,
        created: 0,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      await createBrainSession(options).remember([health, iban]);
      expect(ingestRequests(fetchSpy)[0].facts).toHaveLength(2);
    });
  });

  it('stores own role, style and rate without the own company as scope, keeps customer scopes', async () => {
    const text =
      'Ich bin Projektleiter bei der Muster Haustechnik AG in Zug. Kundenbriefe schreibe ich immer in der Sie-Form, ohne Aufzählungszeichen. Unser Stundensatz für Service-Einsätze beträgt 145 CHF exkl. MWST. Für die Bäckerei Huber gilt Lieferung am Montag. Bitte merke dir das dauerhaft.';
    const source = { id: 'message-own', text, createdAt: '2026-11-06T09:00:00.000Z' };
    const messages: BrainConversationMessage[] = [
      { ...source, role: 'user', contentHash: conversationHash(text) },
    ];
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ nodes: [], skipped: 0, created: 4 }), { status: 200 }),
      );
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'response',
      source,
      contextBudgetTokens: 4000,
      canWrite: true,
      canUpdate: false,
      loadConversation: async () => messages,
      authorizeConversation: async () => true,
    });
    const scoped = (
      quote: string,
      statement: string,
      kind: BrainCandidate['kind'],
      scope: string,
    ) => ({
      quote,
      text: statement,
      kind,
      scope,
      evidence: [{ messageId: 'current-user-message', quote }],
    });
    const result = await session.remember([
      scoped(
        'Ich bin Projektleiter bei der Muster Haustechnik AG in Zug.',
        'Rolle: Projektleiter bei der Muster Haustechnik AG.',
        'person',
        'Muster Haustechnik AG',
      ),
      scoped(
        'Kundenbriefe schreibe ich immer in der Sie-Form, ohne Aufzählungszeichen.',
        'Kundenbriefe immer in der Sie-Form, ohne Aufzählungszeichen.',
        'preference',
        'Muster Haustechnik AG',
      ),
      scoped(
        'Unser Stundensatz für Service-Einsätze beträgt 145 CHF exkl. MWST.',
        'Stundensatz Service-Einsätze: 145 CHF exkl. MWST.',
        'fact',
        'Muster Haustechnik',
      ),
      scoped(
        'Für die Bäckerei Huber gilt Lieferung am Montag.',
        'Für die Bäckerei Huber gilt Lieferung am Montag.',
        'fact',
        'Bäckerei Huber',
      ),
    ]);
    expect(result.error).toBeUndefined();
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
      facts: { scope?: string }[];
    };
    expect(body.facts.map((fact) => fact.scope)).toEqual([
      undefined,
      undefined,
      undefined,
      'Bäckerei Huber',
    ]);
  });

  describe('chat recall ceiling', () => {
    const budgets: { contextBudgetTokens: number; initialBudgetTokens: number }[] = [];
    beforeEach(() => {
      budgets.length = 0;
      jest.spyOn(global, 'fetch').mockImplementation(async (_url, request) => {
        budgets.push(JSON.parse(String(request?.body)));
        return new Response(
          JSON.stringify({
            context: 'Erinnerung',
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
    });
    const ceilingSession = () =>
      createBrainSession({
        userId: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        source,
        contextBudgetTokens: 0,
        canWrite: false,
        canUpdate: false,
        countTokens: async (text) => Math.ceil(text.length / 4),
      });

    it.each([
      [200000, 3000],
      [128000, 3000],
      [32000, 1600],
      [8192, 409],
    ])('limits a window of %i tokens to %i recall tokens', (window, expected) => {
      expect(brainRecallLimitTokens(window)).toBe(expected);
    });

    it('caps the initial recall and every brain_search call, independent of free space', async () => {
      const session = ceilingSession();
      session.setContextBudget(150000, 200000);
      await session.initialize();
      await session.tools[0].invoke({ query: 'Atlas', seedIds: [] });
      expect(budgets.map((budget) => budget.contextBudgetTokens)).toEqual([3000, 3000]);
      expect(budgets[0].initialBudgetTokens).toBe(1600);
    });

    it('keeps the remaining context as the lower bound when it is smaller than the ceiling', async () => {
      const session = ceilingSession();
      session.setContextBudget(1500, 200000);
      await session.initialize();
      expect(budgets[0].contextBudgetTokens).toBeLessThan(1500);
      expect(budgets[0].contextBudgetTokens).toBeGreaterThan(1000);
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
