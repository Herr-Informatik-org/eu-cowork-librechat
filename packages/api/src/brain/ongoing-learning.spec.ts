import { Providers } from '@librechat/agents';
import { learnBrainTurn } from './learning';
import { reviewBrainConversation } from './review';
import { createBrainSession } from './session';
import { conversationMessages } from './conversation';
import type { BrainCandidate, BrainSession } from './session';
import type { BrainConversationMessage } from './conversation';

jest.mock('./review', () => ({ brainReviewVersion: 'test', reviewBrainConversation: jest.fn() }));
const review = jest.mocked(reviewBrainConversation);
const model = { provider: Providers.OPENAI, model: 'test-only' };
const candidate: BrainCandidate = {
  quote: 'Atlas braucht die EU-Region.',
  text: 'Für Atlas ist die EU-Region vereinbart.',
  title: 'Atlas EU-Region',
  kind: 'decision',
  scope: 'Atlas',
  basis: 'confirmed',
  claimState: 'agreed',
  evidence: [
    { messageId: 'u2', quote: 'Ja' },
    { messageId: 'a1', quote: 'EU-Region' },
  ],
};
const base = conversationMessages([
  {
    conversationId: 'conversation',
    messageId: 'u1',
    text: 'Plane Atlas.',
    isCreatedByUser: true,
    createdAt: '2026-09-14',
  },
  {
    conversationId: 'conversation',
    messageId: 'a1',
    parentMessageId: 'u1',
    text: 'Wir können die EU-Region verwenden.',
    isCreatedByUser: false,
    createdAt: '2026-09-14',
  },
  {
    conversationId: 'conversation',
    messageId: 'u2',
    parentMessageId: 'a1',
    text: 'Ja',
    isCreatedByUser: true,
    createdAt: '2026-09-14',
  },
]);
let sequence = 0;
function session(conversationId: string, messages = base) {
  const last = messages[messages.length - 1];
  return createBrainSession({
    userId: 'owner',
    conversationId,
    messageId: 'response',
    source: { id: last.id, text: last.text, createdAt: last.createdAt },
    contextBudgetTokens: 4000,
    canWrite: true,
    canUpdate: true,
    loadConversation: async () => messages,
    canPersist: async () => true,
    authorizeConversation: async () => true,
    organizationContext: { text: 'IT-Dienstleister', version: 'v1' },
    connectionHints: ['CRM'],
  });
}
async function learn(current: BrainSession) {
  await learnBrainTurn({ session: current, llmConfig: model, onUsage: async () => {} });
}
beforeEach(() => {
  jest.resetAllMocks();
  sequence++;
  review.mockImplementation(async (options) => {
    await options.onCheckpoint({
      position: options.messages.length,
      phase: 'done',
      candidates: [candidate],
    });
    return [candidate];
  });
});

describe('contextual ongoing learning', () => {
  it('reviews short acceptance with assistant context and explicit organisation context', async () => {
    const current = session(`short-${sequence}`);
    const remember = jest.spyOn(current, 'remember').mockResolvedValue({ nodes: [], skipped: 0 });
    await learn(current);
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: base,
        organizationContext: { text: 'IT-Dienstleister', version: 'v1' },
        connectionHints: ['CRM'],
      }),
    );
    expect(remember).toHaveBeenCalledWith([candidate], true);
  });
  it('reuses completed candidate state and reviews only appended messages without repeating writes', async () => {
    const id = `append-${sequence}`;
    const first = session(id);
    jest.spyOn(first, 'remember').mockResolvedValue({ nodes: [], skipped: 0 });
    await learn(first);
    const nextMessages: BrainConversationMessage[] = [
      ...base,
      { ...base[2], id: 'u3', parentId: 'u2', text: 'Danke', contentHash: 'new' },
    ];
    const second = session(id, nextMessages);
    const remember = jest.spyOn(second, 'remember').mockResolvedValue({ nodes: [], skipped: 0 });
    await learn(second);
    expect(review.mock.calls[1][0]).toMatchObject({
      resumeAfterMessageId: 'u2',
      checkpoint: { phase: 'extract', candidates: [candidate] },
    });
    expect(remember).not.toHaveBeenCalled();
    await learn(second);
    expect(review).toHaveBeenCalledTimes(2);
  });
  it('retries an interrupted write from the verified checkpoint', async () => {
    const current = session(`retry-${sequence}`);
    const remember = jest
      .spyOn(current, 'remember')
      .mockResolvedValueOnce({ nodes: [], skipped: 1, error: 'temporary' })
      .mockResolvedValue({ nodes: [], skipped: 0 });
    await expect(learn(current)).rejects.toThrow('temporary');
    await learn(current);
    expect(review.mock.calls[1][0].checkpoint?.phase).toBe('done');
    expect(remember).toHaveBeenCalledTimes(2);
  });
  it('resumes within the service fact limit after one ingest batch failed', async () => {
    const current = session(`batch-${sequence}`);
    const facts = Array.from({ length: 45 }, (_, index) => ({
      ...candidate,
      text: `${candidate.text} Detail ${index}.`,
    }));
    review.mockImplementation(async (options) => {
      await options.onCheckpoint({
        position: options.messages.length,
        phase: 'done',
        candidates: facts,
      });
      return facts;
    });
    const remember = jest
      .spyOn(current, 'remember')
      .mockResolvedValueOnce({ nodes: [], skipped: 0 })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ nodes: [], skipped: 0 });
    await expect(learn(current)).rejects.toThrow('temporary');
    await learn(current);
    expect(remember.mock.calls.map(([batch]) => batch.length)).toEqual([40, 5, 5]);
  });

  it('does not persist after a source edit or a newer turn', async () => {
    const current = session(`stale-${sequence}`);
    const remember = jest.spyOn(current, 'remember');
    const controller = new AbortController();
    current.options.signal = controller.signal;
    review.mockImplementation(async () => {
      controller.abort();
      return [candidate];
    });
    await learn(current);
    expect(remember).not.toHaveBeenCalled();
    review.mockClear();
    current.options.authorizeConversation = async () => false;
    await learn(current);
    expect(review).not.toHaveBeenCalled();
  });
});
