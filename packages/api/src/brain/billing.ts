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
}: {
  session: BrainSession;
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
  await learnBrainWithUsage({
    session,
    llmConfig: resolved.llmConfig,
    dependencies,
    usageConfig: { ...usageConfig, endpointTokenConfig: resolved.endpointTokenConfig },
  });
}

/** Account the actual extraction model call through the existing pricing and transaction path. */
export async function learnBrainWithUsage({
  session,
  llmConfig,
  dependencies,
  usageConfig,
}: {
  session: BrainSession;
  llmConfig: LLMConfig;
  dependencies: RecordUsageDeps;
  usageConfig: Pick<RecordUsageParams, 'balance' | 'transactions' | 'endpointTokenConfig'>;
}): Promise<void> {
  await learnBrainTurn({
    session,
    llmConfig,
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
