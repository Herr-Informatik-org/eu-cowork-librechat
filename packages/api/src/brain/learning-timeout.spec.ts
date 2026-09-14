import { Run } from '@librechat/agents';
import { brainLearningTimeoutMs, learnBrainTurn } from './learning';
import { createBrainSession } from './session';

jest.mock('@librechat/agents', () => ({
  Run: { create: jest.fn() },
  createMetadataAggregator: () => ({ handleLLMEnd: jest.fn(), collected: [] }),
}));

describe('Brain learning time budget', () => {
  const previous = process.env.BRAIN_LEARNING_TIMEOUT_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.BRAIN_LEARNING_TIMEOUT_MS;
    else process.env.BRAIN_LEARNING_TIMEOUT_MS = previous;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('allows a valid 31-second model result instead of aborting the import at 30 seconds', async () => {
    delete process.env.BRAIN_LEARNING_TIMEOUT_MS;
    jest.useFakeTimers();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Synthetic timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    jest.mocked(Run.create).mockResolvedValue({
      processStream: async (_input: object, { signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 31000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    } as Awaited<ReturnType<typeof Run.create>>);
    const session = createBrainSession({
      userId: 'owner',
      conversationId: 'conversation',
      messageId: 'message',
      source: {
        id: 'source',
        text: 'Projekt Atlas nutzt PostgreSQL.',
        createdAt: new Date().toISOString(),
      },
      contextBudgetTokens: 2000,
      canWrite: true,
      canUpdate: false,
    });
    const result = learnBrainTurn({
      session,
      llmConfig: { provider: 'openAI', model: 'synthetic' },
      onUsage: async () => {},
    }).then(
      () => 'completed',
      () => 'aborted',
    );
    await jest.advanceTimersByTimeAsync(31000);
    expect(await result).toBe('completed');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120000);
  });

  it.each([
    ['', 120000],
    ['invalid', 120000],
    ['1000', 120000],
    ['90000', 90000],
    ['900000', 300000],
  ])('bounds configured timeout %s to %i', (configured, expected) => {
    process.env.BRAIN_LEARNING_TIMEOUT_MS = configured;
    expect(brainLearningTimeoutMs()).toBe(expected);
  });
});
