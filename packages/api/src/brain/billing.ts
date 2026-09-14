import { providerEndpointMap } from 'librechat-data-provider';
import type { Response } from 'express';
import type { CheckBalanceDeps } from '~/middleware/checkBalance';
import type { BrainReviewOptions } from './review';
import { checkBalance } from '~/middleware/checkBalance';
import { assertUsageCredit } from '~/middleware/usageCredit';
import { getModelMaxTokens } from '~/utils/tokens';
import type { LLMConfig } from '@librechat/agents';
import type { RecordUsageDeps, RecordUsageParams } from '~/agents/usage';
import type { BrainSession } from './session';
import { mapCollectedMetadataToUsage } from '~/agents/activityLabels/host';
import { recordCollectedUsage } from '~/agents/usage';
import { learnBrainTurn } from './learning';
import type { BrainLearningModelOptions } from './model';
import { resolveBrainLearningModel } from './model';

export async function learnConfiguredBrainWithUsage({
  session,
  modelOptions,
  dependencies,
  usageConfig,
  balanceDependencies,
}: {
  session: BrainSession;
  balanceDependencies?: Omit<CheckBalanceDeps, 'balanceConfig' | 'logViolation'>;
  modelOptions: BrainLearningModelOptions;
  dependencies: RecordUsageDeps;
  usageConfig: Pick<RecordUsageParams, 'balance' | 'transactions'>;
}): Promise<void> {
  if (
    session.handledExplicitly ||
    !session.options.canWrite ||
    (session.options.canPersist && !(await session.options.canPersist()))
  ) {
    return;
  }
  const resolved = await resolveBrainLearningModel(modelOptions);
  if (!resolved) return;
  const configured = modelOptions.req?.config?.memory?.agent;
  const configuredCapacity =
    configured && 'model_parameters' in configured
      ? Number(configured.model_parameters?.maxContextTokens)
      : 0;
  const capacity =
    configuredCapacity ||
    getModelMaxTokens(
      resolved.llmConfig.model ?? '',
      providerEndpointMap[resolved.llmConfig.provider as keyof typeof providerEndpointMap],
      resolved.endpointTokenConfig,
    ) ||
    32000;
  const limits = resolved.llmConfig as {
    maxTokens?: number;
    maxOutputTokens?: number;
    maxCompletionTokens?: number;
  };
  const outputTokens = Number(
    limits.maxTokens ?? limits.maxOutputTokens ?? limits.maxCompletionTokens ?? 4096,
  );
  await learnBrainWithUsage({
    session,
    llmConfig: resolved.llmConfig,
    dependencies,
    usageConfig: { ...usageConfig, endpointTokenConfig: resolved.endpointTokenConfig },
    inputBudget: Math.min(
      modelOptions.req?.config?.memory?.maxInputTokens ?? 12000,
      capacity - outputTokens - 3000,
    ),
    configurationFingerprint: JSON.stringify(modelOptions.req?.config?.memory ?? {}),
    beforeModelCall: session.options.loadConversation
      ? async (inputTokens) => {
          await assertUsageCredit();
          if (!usageConfig.balance?.enabled) return;
          if (!balanceDependencies)
            throw new Error('Die Guthabenprüfung für das Brain ist nicht verfügbar.');
          await checkBalance(
            {
              req: modelOptions.req,
              res: {} as Response,
              txData: {
                user: session.options.userId,
                tokenType: 'prompt',
                amount: inputTokens + outputTokens,
                model: resolved.llmConfig.model,
                endpoint: resolved.llmConfig.provider,
                endpointTokenConfig: resolved.endpointTokenConfig,
              },
            },
            {
              ...balanceDependencies,
              balanceConfig: usageConfig.balance,
              logViolation: async () => undefined,
            },
          );
        }
      : undefined,
  });
}

/** Account the actual extraction model call through the existing pricing and transaction path. */
export async function learnBrainWithUsage({
  session,
  llmConfig,
  dependencies,
  usageConfig,
  inputBudget,
  configurationFingerprint,
  beforeModelCall,
}: {
  inputBudget?: number;
  configurationFingerprint?: string;
  beforeModelCall?: BrainReviewOptions['beforeModelCall'];
  session: BrainSession;
  llmConfig: LLMConfig;
  dependencies: RecordUsageDeps;
  usageConfig: Pick<RecordUsageParams, 'balance' | 'transactions' | 'endpointTokenConfig'>;
}): Promise<void> {
  await learnBrainTurn({
    session,
    llmConfig,
    inputBudget,
    configurationFingerprint,
    beforeModelCall,
    onUsage: async (metadata) => {
      const collectedUsage = mapCollectedMetadataToUsage(metadata).map((usage) => ({
        ...usage,
        provider: llmConfig.provider,
      }));
      if (collectedUsage.length > 0) {
        await recordCollectedUsage(dependencies, {
          ...usageConfig,
          user: session.options.userId,
          conversationId: session.options.conversationId,
          messageId: session.options.messageId,
          model: llmConfig.model,
          context: 'brain',
          collectedUsage,
        });
      }
    },
  });
}
