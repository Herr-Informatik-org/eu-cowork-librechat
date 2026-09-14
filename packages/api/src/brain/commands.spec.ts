import { createBrainSession } from './session';
import { requestBrain } from './client';
import type { BrainSessionOptions } from './session';

jest.mock('./client', () => ({ requestBrain: jest.fn(), isBrainConfigured: () => true }));
const request = jest.mocked(requestBrain);
const node = { id: 'atlas', text: 'Atlas nutzt CHF für Offerten.', title: 'Atlas', version: 4 };
const options: BrainSessionOptions = {
  userId: 'alice',
  conversationId: 'chat',
  messageId: 'answer',
  source: {
    id: 'message',
    text: 'Ändere für Atlas die Währung auf EUR. Vergiss danach Atlas.',
    createdAt: '2026-09-14T12:00:00.000Z',
  },
  canWrite: true,
  canUpdate: true,
  contextBudgetTokens: 5000,
  canPersist: async () => true,
  canModify: async () => true,
};
async function loaded(overrides: Partial<BrainSessionOptions> = {}) {
  const session = createBrainSession({ ...options, ...overrides });
  request.mockResolvedValueOnce({
    context: node.text,
    nodes: [node],
    edges: [],
    hasMore: false,
    suggestedIds: ['suggested-only'],
    stopReason: 'fertig',
  });
  await session.initialize();
  request.mockClear();
  return session;
}
const invoke = (session: ReturnType<typeof createBrainSession>, name: string, input: unknown) =>
  session.tools.find((entry) => entry.name === name)!.invoke(input);

describe('direct personal Brain commands', () => {
  beforeEach(() => request.mockReset());

  it('corrects a recalled fact through the versioned service, preserving real chat evidence', async () => {
    const session = await loaded();
    request.mockResolvedValueOnce({
      node: { ...node, text: 'Atlas nutzt EUR für Offerten.', version: 5 },
    });
    const result = JSON.parse(
      String(
        await invoke(session, 'brain_update', { id: node.id, oldText: 'CHF', newText: 'EUR' }),
      ),
    );
    expect(result.updated).toBe(true);
    expect(request).toHaveBeenCalledWith('alice', 'POST', '/v1/nodes/atlas/correct', {
      version: 4,
      oldText: 'CHF',
      newText: 'EUR',
      conversationId: 'chat',
      sourceMessage: options.source,
    });
    request.mockClear();
    await session.remember(
      [{ quote: 'Ändere für Atlas die Währung auf EUR.', kind: 'project' }],
      true,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('requires an actually loaded target and rejects replacements absent from the current source', async () => {
    const session = await loaded();
    await invoke(session, 'brain_update', { id: 'suggested-only', oldText: 'CHF', newText: 'EUR' });
    await invoke(session, 'brain_update', { id: node.id, oldText: 'CHF', newText: 'USD' });
    await invoke(session, 'brain_forget', { ids: ['suggested-only'] });
    expect(request).not.toHaveBeenCalled();
  });

  it('rechecks current UPDATE permission and source availability for update and forget', async () => {
    const session = await loaded({ canModify: async () => false });
    expect(
      String(
        await invoke(session, 'brain_update', { id: node.id, oldText: 'CHF', newText: 'EUR' }),
      ),
    ).toContain('nicht mehr erlaubt');
    expect(String(await invoke(session, 'brain_forget', { ids: [node.id] }))).toContain(
      'nicht mehr erlaubt',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('reports an edit conflict as failure and makes the node available to a new search', async () => {
    const session = await loaded();
    request.mockRejectedValueOnce(new Error('conflict'));
    expect(
      String(
        await invoke(session, 'brain_update', { id: node.id, oldText: 'CHF', newText: 'EUR' }),
      ),
    ).toContain('nicht geändert');
    request.mockResolvedValueOnce({
      context: node.text,
      nodes: [node],
      edges: [],
      hasMore: false,
      suggestedIds: [],
      stopReason: 'fertig',
    });
    await invoke(session, 'brain_search', { query: 'Atlas', seedIds: [] });
    expect(request.mock.calls[request.mock.calls.length - 1]?.[3]).toMatchObject({
      excludeIds: [],
    });
  });

  it('forgets via the owner scoped service and suppresses automatic relearning in the same turn', async () => {
    const session = await loaded();
    request.mockResolvedValueOnce({ deleted: true });
    expect(JSON.parse(String(await invoke(session, 'brain_forget', { ids: [node.id] })))).toEqual({
      deleted: true,
      ids: [node.id],
    });
    expect(request).toHaveBeenCalledWith('alice', 'DELETE', '/v1/nodes/atlas');
    request.mockClear();
    await session.remember([{ quote: 'Vergiss danach Atlas.', kind: 'project' }], true);
    expect(request).not.toHaveBeenCalled();
  });

  it('saves an explicit remember command through the real grounding path', async () => {
    const session = createBrainSession({
      ...options,
      source: { ...options.source, text: 'Merke dir: Meine Projektsprache ist Deutsch.' },
    });
    request.mockResolvedValueOnce({ nodes: [node], skipped: 0 });
    await invoke(session, 'brain_remember', {
      facts: [{ quote: 'Meine Projektsprache ist Deutsch.', kind: 'preference' }],
    });
    expect(request.mock.calls[0][3]).toMatchObject({
      conversationId: 'chat',
      facts: [{ text: 'Meine Projektsprache ist Deutsch.', sourceMessageIds: ['message'] }],
    });
  });

  it('separates historical chunks containing the same fact while retries stay idempotent', async () => {
    request.mockResolvedValue({ nodes: [], skipped: 0, created: 0 });
    const fact = { quote: 'Atlas verwendet CHF.', kind: 'project' as const };
    const first = createBrainSession({
      ...options,
      historical: true,
      source: { ...options.source, text: `Erster Abschnitt. ${fact.quote}` },
    });
    const second = createBrainSession({
      ...options,
      historical: true,
      source: { ...options.source, text: `Zweiter Abschnitt. ${fact.quote}` },
    });
    await first.remember([fact], true);
    await first.remember([fact], true);
    await second.remember([fact], true);
    const bodies = request.mock.calls.map((call) => call[3] as { requestId: string });
    expect(bodies[0].requestId).toBe(bodies[1].requestId);
    expect(bodies[0].requestId).not.toBe(bodies[2].requestId);
    expect(bodies[0].requestId).toMatch(/^history:/);
  });
});
