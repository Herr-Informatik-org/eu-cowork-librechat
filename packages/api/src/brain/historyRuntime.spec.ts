import { Types } from 'mongoose';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import type { BrainHistoryStore, BrainHistoryMessage } from './historyStore';
import {
  createBrainHistoryProcessor,
  brainHistoryChunkEnd,
  brainHistoryModelSelection,
} from './historyRuntime';
import { resolveBrainLearningModel } from './model';
import { learnBrainTurn } from './learning';
import { reviewBrainConversation } from './review';
import { conversationMessages, conversationTranscript } from './conversation';
import { requestBrain, BrainServiceError } from './client';
import { recordCollectedUsage } from '~/agents/usage';
import { checkBalance } from '~/middleware/checkBalance';
import { assertUsageCredit } from '~/middleware/usageCredit';
import { checkAccess } from '~/middleware/access';
import { getModelMaxTokens } from '~/utils/tokens';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('~/app/service', () => ({
  getAppConfigOptionsFromUser: (user: IUser) => ({ userId: user.id, role: user.role }),
}));
jest.mock('~/middleware/usageCredit', () => ({ assertUsageCredit: jest.fn() }));
jest.mock('~/middleware/checkBalance', () => ({ checkBalance: jest.fn() }));
jest.mock('~/middleware/access', () => ({ checkAccess: jest.fn() }));
jest.mock('~/agents/usage', () => ({ recordCollectedUsage: jest.fn() }));
jest.mock('~/utils/tokens', () => ({ getModelMaxTokens: jest.fn() }));
jest.mock('~/utils/tokenizer', () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
}));
jest.mock('./model', () => ({
  ...jest.requireActual('./model'),
  resolveBrainLearningModel: jest.fn(),
}));
jest.mock('./client', () => ({ ...jest.requireActual('./client'), requestBrain: jest.fn() }));
jest.mock('./review', () => ({
  ...jest.requireActual('./review'),
  reviewBrainConversation: jest.fn(),
}));
jest.mock('./learning', () => ({ ...jest.requireActual('./learning'), learnBrainTurn: jest.fn() }));
jest.mock('~/agents/activityLabels/host', () => ({
  mapCollectedMetadataToUsage: () => [
    { input_tokens: 50, output_tokens: 12, model: 'learning-model' },
  ],
}));

const ownerId = '507f1f77bcf86cd799439011';
const source: BrainHistoryMessage = {
  messageId: 'message',
  conversationId: 'chat',
  createdAt: new Date('2026-01-01'),
  text: 'Projekt Morgenrot verwendet einen Freigabeprozess mit zwei Personen.',
};
const req = {
  user: { id: ownerId },
  body: { model: 'untrusted-client-model', endpoint: 'untrusted-client-provider' },
} as ServerRequest;
const pricing = { 'learning-model': { context: 32000, prompt: 0.1, completion: 0.2 } };

function fixture() {
  const user = {
    _id: new Types.ObjectId(ownerId),
    role: 'USER',
    personalization: { memories: true },
  } as IUser;
  const config = {
    memory: { agent: { provider: 'EU Provider', model: 'learning-model' } },
    balance: { enabled: true },
    transactions: { enabled: true },
  } as AppConfig;
  const dependencies = {
    store: {} as BrainHistoryStore,
    getUserById: jest.fn(async () => user),
    getRoleByName: jest.fn(),
    getAppConfig: jest.fn(async () => config),
    db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
    usage: { spendTokens: jest.fn(), spendStructuredTokens: jest.fn() },
    balance: {
      findBalanceByUser: jest.fn(),
      getMultiplier: jest.fn(),
      createAutoRefillTransaction: jest.fn(),
    },
  };
  return { processor: createBrainHistoryProcessor(dependencies), dependencies, user, config };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BRAIN_API_URL = 'http://synthetic-brain';
  process.env.BRAIN_SHARED_SECRET = 'synthetic-shared-key';
  delete process.env.BRAIN_ENABLED;
  jest.mocked(checkAccess).mockResolvedValue(true);
  jest.mocked(assertUsageCredit).mockResolvedValue(undefined);
  jest.mocked(checkBalance).mockResolvedValue(true);
  jest.mocked(getModelMaxTokens).mockReturnValue(32000);
  jest.mocked(resolveBrainLearningModel).mockResolvedValue({
    llmConfig: { provider: 'openAI', model: 'learning-model', apiKey: 'synthetic-target-key' },
    endpointTokenConfig: pricing,
  });
  jest.mocked(requestBrain).mockResolvedValue({
    context: '',
    nodes: [],
    edges: [],
    recall: {},
    hasMore: false,
    suggestedIds: [],
    stopReason: '',
  });
  jest.mocked(learnBrainTurn).mockImplementation(async ({ session, onUsage }) => {
    await session.remember([{ quote: source.text, kind: 'project' }], true);
    await onUsage([]);
  });
});

afterAll(() => {
  delete process.env.BRAIN_API_URL;
  delete process.env.BRAIN_SHARED_SECRET;
});

describe('historical learning through the configured runtime', () => {
  it('selects the trusted default model spec and excludes its task instructions', () => {
    const config = {
      modelSpecs: {
        list: [
          {
            name: 'other',
            label: 'Other',
            preset: { endpoint: 'other-provider', model: 'other-model' },
          },
          {
            name: 'default',
            label: 'Default',
            default: true,
            preset: {
              endpoint: 'trusted-provider',
              model: 'trusted-model',
              temperature: 0.2,
              promptPrefix: 'Do not send this task prompt to memory.',
            },
          },
        ],
      },
    } as AppConfig;
    expect(brainHistoryModelSelection(config)).toEqual({
      provider: 'trusted-provider',
      model: 'trusted-model',
      model_parameters: { temperature: 0.2 },
    });
  });

  it('does not invent a default provider when none is configured', () => {
    const { config } = fixture();
    delete config.memory!.agent;
    config.modelSpecs = { list: [], enforce: false, prioritize: true };
    expect(() => brainHistoryModelSelection(config)).toThrow(/Standardmodell/);
  });

  it('normalizes a lean Mongo user and sends only owned user text through the configured model', async () => {
    const { processor, dependencies } = fixture();
    const onFacts = jest.fn();
    const onBilling = jest.fn();
    await processor.extract({
      req,
      source,
      text: source.text,
      canContinue: async () => true,
      onFacts,
      onBilling,
    });
    expect(dependencies.getAppConfig).toHaveBeenCalledWith({ userId: ownerId, role: 'USER' });
    expect(resolveBrainLearningModel).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ body: {}, user: expect.objectContaining({ id: ownerId }) }),
      }),
    );
    const session = jest.mocked(learnBrainTurn).mock.calls[0][0].session;
    expect(session.options).toMatchObject({
      userId: ownerId,
      historical: true,
      canUpdate: false,
      source: { text: source.text },
    });
    expect(onFacts).toHaveBeenCalledWith([{ quote: source.text, kind: 'project' }]);
    expect(onBilling.mock.calls).toEqual([['started'], ['complete']]);
    expect(recordCollectedUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        user: ownerId,
        model: 'learning-model',
        endpointTokenConfig: pricing,
        context: 'brain',
      }),
    );
    expect(checkBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        txData: expect.objectContaining({
          user: ownerId,
          model: 'learning-model',
          endpointTokenConfig: pricing,
        }),
      }),
      expect.anything(),
    );
  });

  it('rechecks opt-out but allows deliberate bootstrap while ongoing learning is paused', async () => {
    const { processor, user, config } = fixture();
    expect(await processor.availability(req)).toMatchObject({ available: true });
    user.personalization!.memories = false;
    expect(await processor.availability(req)).toMatchObject({ available: false });
    user.personalization!.memories = true;
    config.memory!.agent!.enabled = false;
    expect(await processor.availability(req)).toMatchObject({
      available: true,
    });
  });

  it('rejects a mismatched user record rather than sending an undefined or foreign owner', async () => {
    const { processor, user } = fixture();
    user._id = new Types.ObjectId();
    expect(await processor.availability(req)).toMatchObject({ available: false });
    expect(requestBrain).not.toHaveBeenCalled();
  });

  it('checks budget before invoking the provider and reports exhaustion without a charge', async () => {
    const { processor } = fixture();
    jest.mocked(checkBalance).mockRejectedValueOnce(new Error('budget exhausted'));
    await expect(
      processor.extract({
        req,
        source,
        text: source.text,
        canContinue: async () => true,
        onFacts: jest.fn(),
        onBilling: jest.fn(),
      }),
    ).rejects.toThrow(/Guthaben/);
    expect(learnBrainTurn).not.toHaveBeenCalled();
    expect(recordCollectedUsage).not.toHaveBeenCalled();
  });

  it('blocks an extraction whose original source disappeared before the provider request', async () => {
    const { processor } = fixture();
    await expect(
      processor.extract({
        req,
        source,
        text: source.text,
        canContinue: async () => false,
        onFacts: jest.fn(),
        onBilling: jest.fn(),
      }),
    ).rejects.toThrow(/Originalquelle/);
    expect(learnBrainTurn).not.toHaveBeenCalled();
  });

  it('filters unsupported quotes and supersedes from historical candidates', async () => {
    const { processor } = fixture();
    jest.mocked(learnBrainTurn).mockImplementationOnce(async ({ session }) => {
      await session.remember(
        [
          { quote: 'This was invented by an assistant.', kind: 'fact' },
          { quote: source.text, kind: 'project', supersedesId: 'current-confirmed-node' },
        ],
        true,
      );
    });
    const onFacts = jest.fn();
    await processor.extract({
      req,
      source,
      text: source.text,
      canContinue: async () => true,
      onFacts,
      onBilling: jest.fn(),
    });
    expect(onFacts).toHaveBeenCalledWith([]);
  });

  it('drops deleted relationship targets on resume and retains the grounded fact', async () => {
    const { processor } = fixture();
    jest.mocked(requestBrain).mockRejectedValueOnce(new BrainServiceError(404));
    jest
      .mocked(requestBrain)
      .mockResolvedValueOnce({ nodes: [{ id: 'new-node' }], skipped: 0, created: 1 });
    expect(
      await processor.ingest({
        req,
        source,
        text: source.text,
        facts: [{ quote: source.text, kind: 'project', relatedIds: ['deleted-node'] }],
        canContinue: async () => true,
      }),
    ).toBe(1);
    expect(requestBrain).toHaveBeenLastCalledWith(
      ownerId,
      'POST',
      '/v1/ingest',
      expect.objectContaining({
        historical: true,
        facts: [expect.objectContaining({ relatedIds: [] })],
      }),
    );
  });

  it('reports service outages instead of considering the message processed', async () => {
    const { processor } = fixture();
    jest.mocked(requestBrain).mockRejectedValueOnce(new BrainServiceError(503));
    await expect(
      processor.ingest({
        req,
        source,
        text: source.text,
        facts: [{ quote: source.text, kind: 'fact' }],
        canContinue: async () => true,
      }),
    ).rejects.toThrow();
  });

  it('honours OpenAI completion limits nested in modelKwargs when splitting text', async () => {
    const { processor } = fixture();
    jest.mocked(getModelMaxTokens).mockReturnValue(16000);
    jest.mocked(resolveBrainLearningModel).mockResolvedValueOnce({
      llmConfig: {
        provider: 'openAI',
        model: 'gpt-test',
        modelKwargs: { max_completion_tokens: 10000 },
      },
    });
    const end = await processor.chunk(req, { ...source, text: 'x'.repeat(50000) }, 0);
    expect(end).toBeGreaterThan(100);
    expect(end).toBeLessThan(10000);
  });

  it('bounds individual source payloads without limiting the total message length', async () => {
    const text = 'x'.repeat(250000);
    const first = await brainHistoryChunkEnd(text, 0, 100000);
    const second = await brainHistoryChunkEnd(text, first, 100000);
    expect(first).toBe(120000);
    expect(second).toBe(240000);
    expect(await brainHistoryChunkEnd(text, second, 100000)).toBe(text.length);
  });
});

describe('canonical conversation bootstrap runtime', () => {
  const messages = conversationMessages([
    {
      messageId: 'u1',
      conversationId: 'chat',
      isCreatedByUser: true,
      createdAt: new Date(1000),
      text: 'Für Atlas brauchen wir einen Freigabeprozess.',
    },
    {
      messageId: 'a1',
      parentMessageId: 'u1',
      conversationId: 'chat',
      isCreatedByUser: false,
      createdAt: new Date(2000),
      text: 'Für Atlas könnten zwei Personen freigeben.',
    },
    {
      messageId: 'u2',
      parentMessageId: 'a1',
      conversationId: 'chat',
      isCreatedByUser: true,
      createdAt: new Date(3000),
      text: 'Ja, genau so. Das ist für dieses Projekt wichtig.',
    },
  ]);
  const contextual = { ...source, messages, text: conversationTranscript(messages) };
  const fact = {
    quote: 'Für Atlas ist eine Freigabe durch zwei Personen vereinbart.',
    text: 'Für Atlas ist eine Freigabe durch zwei Personen vereinbart.',
    title: 'Atlas-Freigabe',
    kind: 'decision' as const,
    scope: 'Atlas',
    basis: 'confirmed' as const,
    claimState: 'agreed' as const,
    evidence: [
      { messageId: 'a1', quote: messages[1].text },
      { messageId: 'u2', quote: messages[2].text },
    ],
  };

  it('passes the complete conversation with initial model and separately versioned context', async () => {
    const { processor, config } = fixture();
    config.memory!.bootstrapAgent = { provider: 'Initial Provider', model: 'initial-model' };
    config.memory!.organizationContext = {
      text: 'Unternehmen entwickelt Software.',
      version: 'v1',
    };
    jest.mocked(requestBrain).mockResolvedValueOnce({
      context: 'Known staged memory',
      nodes: [
        { id: 'stage', confidence: 'observed' },
        { id: 'manual', confidence: 'confirmed' },
      ],
    });
    jest.mocked(reviewBrainConversation).mockImplementationOnce(async (options) => {
      await options.beforeModelCall!(500, 200);
      await options.onCheckpoint({ phase: 'done', position: 3, candidates: [fact] });
      return [fact];
    });
    const onFacts = jest.fn();
    await processor.extract({
      req,
      source: contextual,
      text: contextual.text,
      rebuildId: 'draft',
      canContinue: async () => true,
      onFacts,
      onBilling: jest.fn(),
      onReview: jest.fn(),
    });
    expect(resolveBrainLearningModel).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'bootstrap', req: expect.objectContaining({ body: {} }) }),
    );
    expect(reviewBrainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        organizationContext: config.memory!.organizationContext,
        connectionHints: [],
        knownIds: new Set(['stage']),
      }),
    );
    expect(onFacts).toHaveBeenCalledWith([fact]);
    expect(learnBrainTurn).not.toHaveBeenCalled();
    expect(requestBrain).toHaveBeenCalledWith(
      ownerId,
      'POST',
      '/v1/recall',
      expect.objectContaining({ generationId: 'draft', recordTrace: false }),
    );
  });

  it('preserves every source dependency and exact evidence while batching a large result', async () => {
    const { processor } = fixture();
    jest.mocked(requestBrain).mockImplementation(async (_owner, _method, _path, body) => ({
      created: (body as { facts: unknown[] }).facts.length,
      nodes: [],
    }));
    const input = {
      req,
      source: contextual,
      text: contextual.text,
      facts: Array.from({ length: 41 }, (_, i) => ({ ...fact, text: `${fact.text} Regel ${i}.` })),
      canContinue: async () => true,
      rebuildId: 'draft',
    };
    expect(await processor.ingest(input)).toBe(41);
    expect(requestBrain).toHaveBeenCalledTimes(2);
    const bodies = jest.mocked(requestBrain).mock.calls.map(
      (call) =>
        call[3] as {
          facts: { sourceMessageIds: string[] }[];
          sourceMessages: { id: string; text?: string; contentHash: string }[];
          requestId: string;
        },
    );
    expect(bodies.map((body) => body.facts.length)).toEqual([40, 1]);
    expect(bodies[0].facts[0].sourceMessageIds).toEqual(['u1', 'a1', 'u2']);
    expect(bodies[0].sourceMessages[0]).toMatchObject({
      id: 'u1',
      contentHash: messages[0].contentHash,
    });
    expect(bodies[0].sourceMessages[0].text).toBeUndefined();
    expect(bodies[0].sourceMessages[1].text).toBe(messages[1].text);
    const ids = bodies.map((body) => body.requestId);
    jest.mocked(requestBrain).mockClear();
    await processor.ingest(input);
    expect(
      jest
        .mocked(requestBrain)
        .mock.calls.map((call) => (call[3] as { requestId: string }).requestId),
    ).toEqual(ids);
  });

  it('stops an oversized source before invoking a model', async () => {
    const { processor } = fixture();
    const oversized = { ...contextual, messages: [{ ...messages[0], text: 'x'.repeat(120001) }] };
    await expect(
      processor.extract({
        req,
        source: oversized,
        text: oversized.text,
        canContinue: async () => true,
        onFacts: jest.fn(),
        onBilling: jest.fn(),
      }),
    ).rejects.toThrow(/Importgrösse/);
    expect(resolveBrainLearningModel).not.toHaveBeenCalled();
    expect(reviewBrainConversation).not.toHaveBeenCalled();
  });

  it('marks a draft ready through the internal service without activating it', async () => {
    const { processor } = fixture();
    await processor.complete!(req, 'draft');
    expect(requestBrain).toHaveBeenCalledWith(
      ownerId,
      'POST',
      '/v1/rebuild/draft/complete',
      {},
      120000,
    );
    expect(requestBrain).toHaveBeenCalledTimes(1);
  });
});
