import { Providers } from '@librechat/agents';
import type { BrainLearningModelOptions } from './model';
import type { RecordUsageDeps } from '~/agents/usage';
import { createBrainSession } from './session';
import { resolveBrainLearningModel } from './model';
import { learnBrainTurn } from './learning';
import { recordCollectedUsage } from '~/agents/usage';
import { learnConfiguredBrainWithUsage } from './billing';

jest.mock('./model', () => ({ resolveBrainLearningModel: jest.fn() }));
jest.mock('./learning', () => ({ learnBrainTurn: jest.fn() }));
jest.mock('~/agents/usage', () => ({ recordCollectedUsage: jest.fn() }));
jest.mock('~/agents/activityLabels/host', () => ({
  mapCollectedMetadataToUsage: () => [{ input_tokens: 120, output_tokens: 40 }],
}));

const resolve = jest.mocked(resolveBrainLearningModel);
const learn = jest.mocked(learnBrainTurn);
const modelOptions = {} as BrainLearningModelOptions;
const dependencies = {} as RecordUsageDeps;
const targetPricing = { 'learning-model': { prompt: 0.4, completion: 0.8, context: 32000 } };
function session(canPersist = true) {
  return createBrainSession({
    userId: 'owner',
    conversationId: 'conversation',
    messageId: 'response',
    source: { id: 'source', text: 'Ich arbeite an Atlas.', createdAt: '2026-09-14' },
    contextBudgetTokens: 1000,
    canWrite: true,
    canUpdate: true,
    canPersist: async () => canPersist,
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  resolve.mockResolvedValue({
    llmConfig: { provider: Providers.OPENAI, model: 'learning-model' },
    endpointTokenConfig: targetPricing,
  });
  learn.mockImplementation(async ({ onUsage }) => onUsage([]));
});

describe('configured Brain learning billing', () => {
  it('records the destination model and its prices against the originating user and chat', async () => {
    await learnConfiguredBrainWithUsage({
      session: session(),
      modelOptions,
      dependencies,
      usageConfig: { transactions: { enabled: true } },
    });
    expect(recordCollectedUsage).toHaveBeenCalledWith(
      dependencies,
      expect.objectContaining({
        user: 'owner',
        conversationId: 'conversation',
        messageId: 'response',
        model: 'learning-model',
        context: 'brain',
        endpointTokenConfig: targetPricing,
        collectedUsage: [{ input_tokens: 120, output_tokens: 40, provider: Providers.OPENAI }],
      }),
    );
  });
  it('does not initialize another provider for a source or permission that expired', async () => {
    await learnConfiguredBrainWithUsage({
      session: session(false),
      modelOptions,
      dependencies,
      usageConfig: {},
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(learn).not.toHaveBeenCalled();
  });
  it('makes no learning call or charge for a paused model configuration', async () => {
    resolve.mockResolvedValueOnce(null);
    await learnConfiguredBrainWithUsage({
      session: session(),
      modelOptions,
      dependencies,
      usageConfig: {},
    });
    expect(learn).not.toHaveBeenCalled();
    expect(recordCollectedUsage).not.toHaveBeenCalled();
  });
  it('avoids a second model call after a direct chat command handled the memory', async () => {
    const handled = session();
    Object.defineProperty(handled, 'handledExplicitly', { value: true });
    await learnConfiguredBrainWithUsage({
      session: handled,
      modelOptions,
      dependencies,
      usageConfig: {},
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(learn).not.toHaveBeenCalled();
    expect(recordCollectedUsage).not.toHaveBeenCalled();
  });
});
