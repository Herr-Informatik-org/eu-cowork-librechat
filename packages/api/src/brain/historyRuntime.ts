import {
  Permissions,
  PermissionTypes,
  EModelEndpoint,
  providerEndpointMap,
  DEFAULT_MEMORY_MAX_INPUT_TOKENS,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { AppConfig, UserMethods } from '@librechat/data-schemas';
import type { TMemoryConfig } from 'librechat-data-provider';
import type { EndpointDbMethods, ServerRequest } from '~/types';
import type { CheckAccessParams } from '~/middleware/access';
import type { CheckBalanceDeps } from '~/middleware/checkBalance';
import type { GetAppConfigOptions } from '~/app/service';
import type { RecordUsageDeps } from '~/agents/usage';
import type { BrainSession, BrainCandidate } from './session';
import type { BrainLearningModel } from './model';
import type { BrainHistoryMessage, BrainHistoryStore } from './historyStore';
import type { BrainHistoryProcessor, BrainHistoryService } from './history';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getBalanceConfig, getTransactionsConfig } from '~/app/config';
import { assertUsageCredit } from '~/middleware/usageCredit';
import { checkBalance } from '~/middleware/checkBalance';
import { checkAccess } from '~/middleware/access';
import { mapCollectedMetadataToUsage } from '~/agents/activityLabels/host';
import { recordCollectedUsage } from '~/agents/usage';
import { getModelMaxTokens } from '~/utils/tokens';
import { countTokens } from '~/utils/tokenizer';
import { resolveBrainLearningModel, BrainLearningConfigurationError } from './model';
import { brainLearningInstructions, learnBrainTurn, shouldLearnBrain } from './learning';
import { createBrainSession, groundedBrainFacts, isBrainChatEligible } from './session';
import { createBrainHistoryService, BrainHistoryError } from './history';
import { requestBrain, BrainServiceError } from './client';

import type { BrainFailureReporter } from './diagnostics';
import type { BrainNode } from 'librechat-data-provider';
import { conversationHash } from './conversation';
import { brainReviewVersion, reviewBrainConversation, validateContextualFacts } from './review';

interface BrainHistoryRuntimeDependencies {
  connectionHints?: (req: ServerRequest) => Promise<string[]>;
  reportFailure?: BrainFailureReporter;
  store: BrainHistoryStore;
  getUserById: UserMethods['getUserById'];
  getRoleByName: CheckAccessParams['getRoleByName'];
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  db: EndpointDbMethods;
  usage: RecordUsageDeps;
  balance: Omit<CheckBalanceDeps, 'balanceConfig' | 'logViolation'>;
}

/** No conversation/model choice from the HTTP body participates in historical processing. */
export function brainHistoryModelSelection(config: AppConfig): NonNullable<TMemoryConfig['agent']> {
  const bootstrap = config.memory?.bootstrapAgent;
  const configured = bootstrap && !('inherit' in bootstrap) ? bootstrap : config.memory?.agent;
  if (configured && !('inherit' in configured)) return { ...configured, enabled: true };
  const specs = config.modelSpecs?.list ?? [];
  const selected =
    specs.find((spec) => spec.default) ??
    specs.find((spec) => spec.softDefault) ??
    specs.find((spec) => spec.showInMenu !== false);
  const preset = selected?.preset;
  const provider =
    preset && 'provider' in preset && typeof preset.provider === 'string'
      ? preset.provider
      : preset?.endpoint;
  const model = preset?.model;
  if (!provider || provider === EModelEndpoint.agents || !model) {
    throw new BrainHistoryError(
      'Für den Import fehlt ein konfiguriertes Standardmodell. Die Administration kann unter Modelle → Brain ein Lernmodell auswählen.',
    );
  }
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(preset)) {
    if (
      [
        'provider',
        'endpoint',
        'model',
        'promptPrefix',
        'instructions',
        'agent_id',
        'assistant_id',
      ].includes(key)
    )
      continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      parameters[key] = value;
  }
  return { provider, model, model_parameters: parameters };
}

export async function brainHistoryChunkEnd(
  text: string,
  offset: number,
  maxTokens: number,
): Promise<number> {
  if (!text.length) return 0;
  if (maxTokens < 128)
    throw new BrainHistoryError(
      'Das konfigurierte Lernmodell bietet zu wenig Kontext für den Import.',
    );
  let low = offset + 1;
  let high = Math.min(text.length, offset + maxTokens * 8, offset + 120000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((await countTokens(JSON.stringify(text.slice(offset, middle)))) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end < text.length) {
    const boundary = Math.max(
      text.lastIndexOf('\n', end),
      text.lastIndexOf('. ', end),
      text.lastIndexOf('。', end),
    );
    if (boundary > offset + (end - offset) * 0.75) end = boundary + 1;
    if (/^[\uDC00-\uDFFF]$/.test(text[end] ?? '')) end--;
  }
  return Math.max(offset + 1, end);
}

export function createBrainHistoryProcessor(
  deps: BrainHistoryRuntimeDependencies,
): BrainHistoryProcessor {
  const refresh = async (req: ServerRequest): Promise<ServerRequest> => {
    if (!req.user?.id) throw new BrainHistoryError('Bitte melde dich erneut an.');
    const ownerId = String(req.user.id);
    const record = await deps.getUserById(ownerId);
    if (!record || String(record._id ?? record.id) !== ownerId)
      throw new BrainHistoryError('Das Benutzerkonto ist nicht mehr verfügbar.');
    const user = Object.assign(record, { id: ownerId });
    const config = await deps.getAppConfig(getAppConfigOptionsFromUser(user));
    if (
      !isBrainChatEligible({
        memoriesEnabled: user.personalization?.memories,
        memoryDisabled: config.memory?.disabled,
      })
    ) {
      throw new BrainHistoryError(
        'Brain ist deaktiviert oder Erinnerungen sind für dein Konto ausgeschaltet.',
      );
    }
    const allowed = await checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE, Permissions.READ, Permissions.CREATE],
      getRoleByName: deps.getRoleByName,
    });
    if (!allowed)
      throw new BrainHistoryError(
        'Du hast keine Berechtigung, persönliche Erinnerungen aus Chats zu erstellen.',
      );
    const fresh: ServerRequest = Object.assign(Object.create(req), { user, config, body: {} });
    return fresh;
  };

  const resolve = async (
    req: ServerRequest,
    source: BrainHistoryMessage,
  ): Promise<{ req: ServerRequest; model: BrainLearningModel }> => {
    const fresh = await refresh(req);
    const selected = brainHistoryModelSelection(fresh.config!);
    const withModel: ServerRequest = Object.assign(Object.create(fresh), {
      config: { ...fresh.config, memory: { ...fresh.config?.memory, agent: selected } },
    });
    try {
      const model = await resolveBrainLearningModel({
        req: withModel,
        agent: { provider: '' },
        ids: { conversationId: source.conversationId, messageId: source.messageId },
        db: deps.db,
        purpose: 'bootstrap',
      });
      if (!model) throw new BrainHistoryError('Das Brain-Lernen ist ausgeschaltet.');
      return { req: withModel, model };
    } catch (error) {
      if (error instanceof BrainLearningConfigurationError)
        throw new BrainHistoryError(error.message);
      throw error;
    }
  };

  const sessionFor = (
    req: ServerRequest,
    source: BrainHistoryMessage,
    text: string,
    canContinue: () => Promise<boolean>,
  ) =>
    createBrainSession({
      userId: String(req.user!.id),
      conversationId: source.conversationId,
      messageId: source.messageId,
      source: { id: source.messageId, text, createdAt: new Date(source.createdAt).toISOString() },
      canWrite: true,
      canUpdate: false,
      historical: true,
      canPersist: canContinue,
      contextBudgetTokens: 2200,
      countTokens,
    });

  const processor: BrainHistoryProcessor = {
    async availability(req) {
      try {
        const fresh = await refresh(req);
        const selected = brainHistoryModelSelection(fresh.config!);
        if (
          !('provider' in selected) ||
          !selected.provider ||
          !('model' in selected) ||
          !selected.model
        ) {
          throw new BrainHistoryError(
            'Bitte unter Modelle → Brain einen Anbieter und ein Modell auswählen; gespeicherte Agent-IDs werden für den Import nicht unterstützt.',
          );
        }
        const hints = fresh.config?.memory?.useMcpContext
          ? ((await deps.connectionHints?.(fresh)) ?? [])
          : [];
        return {
          available: true,
          modelLabel: `${selected.provider} · ${selected.model}`,
          analysisFingerprint: conversationHash(
            JSON.stringify({
              selected,
              context: fresh.config?.memory?.organizationContext,
              hints,
              version: brainReviewVersion,
            }),
          ),
        };
      } catch (error) {
        return {
          available: false,
          reason:
            error instanceof BrainHistoryError
              ? error.message
              : 'Die Berechtigung oder Konfiguration konnte nicht geprüft werden.',
        };
      }
    },
    async chunk(req, source, offset) {
      if (source.messages) return source.text.length;
      const { req: fresh, model } = await resolve(req, source);
      const parameters = fresh.config?.memory?.agent;
      const configuredContext =
        parameters && 'model_parameters' in parameters
          ? Number(parameters.model_parameters?.maxContextTokens)
          : 0;
      const capacity =
        configuredContext ||
        getModelMaxTokens(
          model.llmConfig.model ?? '',
          providerEndpointMap[model.llmConfig.provider as keyof typeof providerEndpointMap],
          model.endpointTokenConfig,
        ) ||
        32000;
      const limits = model.llmConfig as {
        maxTokens?: number;
        maxOutputTokens?: number;
        maxCompletionTokens?: number;
        modelKwargs?: { max_completion_tokens?: number; max_output_tokens?: number };
      };
      const output = Number(
        limits.maxTokens ??
          limits.maxOutputTokens ??
          limits.maxCompletionTokens ??
          limits.modelKwargs?.max_completion_tokens ??
          limits.modelKwargs?.max_output_tokens ??
          2048,
      );
      const overhead = (await countTokens(brainLearningInstructions)) + 3500;
      const limit = Math.min(
        fresh.config?.memory?.maxInputTokens ?? DEFAULT_MEMORY_MAX_INPUT_TOKENS,
        capacity - output - overhead,
      );
      return brainHistoryChunkEnd(source.text, offset, limit);
    },
    async extract({
      req,
      source,
      text,
      canContinue,
      onFacts,
      onBilling,
      review,
      onReview,
      rebuildId,
    }) {
      if (source.messages) {
        if (
          source.messages.length > 2000 ||
          source.messages.some((message) => message.text.length > 120000)
        )
          throw new BrainHistoryError(
            'Dieser Chat überschreitet die sichere Importgrösse (2’000 Beiträge beziehungsweise 120’000 Zeichen pro Beitrag). Es wurden keine Modellanfragen gestartet; bitte diesen Verlauf zuerst aufteilen.',
          );
        const { req: fresh, model } = await resolve(req, source);
        const selected = brainHistoryModelSelection(fresh.config!);
        const configuredContext =
          'model_parameters' in selected ? Number(selected.model_parameters?.maxContextTokens) : 0;
        const capacity =
          configuredContext ||
          getModelMaxTokens(
            model.llmConfig.model ?? '',
            providerEndpointMap[model.llmConfig.provider as keyof typeof providerEndpointMap],
            model.endpointTokenConfig,
          ) ||
          32000;
        const limits = model.llmConfig as {
          maxTokens?: number;
          maxOutputTokens?: number;
          maxCompletionTokens?: number;
          modelKwargs?: { max_completion_tokens?: number; max_output_tokens?: number };
        };
        const output = Number(
          limits.maxTokens ??
            limits.maxOutputTokens ??
            limits.maxCompletionTokens ??
            limits.modelKwargs?.max_completion_tokens ??
            limits.modelKwargs?.max_output_tokens ??
            4096,
        );
        const recalled = rebuildId
          ? await requestBrain<{ context: string; nodes: BrainNode[] }>(
              String(fresh.user!.id),
              'POST',
              '/v1/recall',
              {
                generationId: rebuildId,
                query: source.messages
                  .map((message) => message.text)
                  .join('\n')
                  .slice(-12000),
                contextBudgetTokens: Math.min(4000, Math.floor(capacity / 8)),
                recordTrace: false,
              },
            )
          : { context: '', nodes: [] };
        const knownIds = new Set(
          recalled.nodes.filter((node) => node.confidence !== 'confirmed').map((node) => node.id),
        );
        const organization = fresh.config?.memory?.organizationContext;
        const facts = await reviewBrainConversation({
          userId: String(fresh.user!.id),
          conversationId: source.conversationId,
          messages: source.messages,
          llmConfig: model.llmConfig,
          inputBudget: capacity - output - 3000,
          countTokens,
          organizationContext:
            organization?.text && organization.version
              ? { text: organization.text, version: organization.version }
              : undefined,
          connectionHints: fresh.config?.memory?.useMcpContext
            ? ((await deps.connectionHints?.(fresh)) ?? [])
            : [],
          existingContext: recalled.context,
          knownIds,
          checkpoint: review,
          canContinue,
          onCheckpoint: async (checkpoint) => {
            await onReview?.(checkpoint);
            if (checkpoint.phase === 'done') await onFacts(checkpoint.candidates);
          },
          beforeModelCall: async (inputTokens) => {
            try {
              await assertUsageCredit();
              const balanceConfig = getBalanceConfig(fresh.config);
              if (balanceConfig?.enabled)
                await checkBalance(
                  {
                    req: fresh,
                    res: {} as Response,
                    txData: {
                      user: String(fresh.user!.id),
                      tokenType: 'prompt',
                      amount: inputTokens + output,
                      model: model.llmConfig.model,
                      endpoint: model.llmConfig.provider,
                      endpointTokenConfig: model.endpointTokenConfig,
                    },
                  },
                  { ...deps.balance, balanceConfig, logViolation: async () => undefined },
                );
            } catch {
              throw new BrainHistoryError(
                'Das verfügbare Guthaben reicht für die weitere Gesprächsanalyse nicht aus.',
                'budget',
              );
            }
          },
          onUsage: async (metadata) => {
            const collectedUsage = mapCollectedMetadataToUsage(metadata).map((usage) => ({
              ...usage,
              provider: model.llmConfig.provider,
            }));
            if (!collectedUsage.length) return;
            await onBilling('started');
            let failed = false;
            const pending: Promise<unknown>[] = [];
            const track =
              <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
              (...args: A): Promise<R> => {
                const promise = fn(...args).catch((error) => {
                  failed = true;
                  throw error;
                });
                pending.push(promise);
                return promise;
              };
            await recordCollectedUsage(
              {
                ...deps.usage,
                spendTokens: track(deps.usage.spendTokens),
                spendStructuredTokens: track(deps.usage.spendStructuredTokens),
                ...(deps.usage.bulkWriteOps
                  ? {
                      bulkWriteOps: {
                        insertMany: track(deps.usage.bulkWriteOps.insertMany),
                        updateBalance: track(deps.usage.bulkWriteOps.updateBalance),
                      },
                    }
                  : {}),
              },
              {
                user: String(fresh.user!.id),
                conversationId: source.conversationId,
                messageId: source.messageId,
                model: model.llmConfig.model,
                context: 'brain_bootstrap',
                balance: getBalanceConfig(fresh.config),
                transactions: getTransactionsConfig(fresh.config),
                endpointTokenConfig: model.endpointTokenConfig,
                collectedUsage,
              },
            );
            await Promise.allSettled(pending);
            if (failed)
              throw new BrainHistoryError(
                'Die Modellnutzung konnte nicht abschliessend verbucht werden.',
                'billing',
              );
            await onBilling('complete');
          },
        });
        await onFacts(facts);
        return;
      }
      if (!shouldLearnBrain(text)) {
        await onFacts([]);
        return;
      }
      const { req: fresh, model } = await resolve(req, source);
      const session = sessionFor(fresh, source, text, canContinue);
      await session.initialize();
      if (!(await canContinue()))
        throw new BrainHistoryError(
          'Die Originalquelle oder die Berechtigung ist nicht mehr verfügbar.',
        );
      try {
        await assertUsageCredit();
        const balanceConfig = getBalanceConfig(fresh.config);
        if (balanceConfig?.enabled) {
          await checkBalance(
            {
              req: fresh,
              res: {} as Response,
              txData: {
                user: String(fresh.user!.id),
                tokenType: 'prompt',
                amount:
                  (await countTokens(
                    `${brainLearningInstructions}\n${session.context}\n${JSON.stringify(text)}`,
                  )) + 800,
                model: model.llmConfig.model,
                endpoint: model.llmConfig.provider,
                endpointTokenConfig: model.endpointTokenConfig,
              },
            },
            { ...deps.balance, balanceConfig, logViolation: async () => undefined },
          );
        }
      } catch {
        throw new BrainHistoryError(
          'Das verfügbare Guthaben reicht nicht aus oder konnte nicht geprüft werden. Der Import ist angehalten.',
          'budget',
        );
      }
      let checkpointed = false;
      const captureSession: BrainSession = Object.assign(Object.create(session), {
        remember: async (candidates: BrainCandidate[]) => {
          if (!(await canContinue()))
            throw new BrainHistoryError(
              'Die Originalquelle oder die Berechtigung ist nicht mehr verfügbar.',
            );
          // Historical evidence may add facts; it never supersedes a later user edit.
          const valid = candidates.filter(
            (candidate) =>
              !candidate.supersedesId &&
              groundedBrainFacts([candidate], session.options.source, session.knownIds).length > 0,
          );
          await onFacts(valid);
          checkpointed = true;
          return { nodes: [], skipped: candidates.length - valid.length };
        },
      });
      await learnBrainTurn({
        session: captureSession,
        llmConfig: model.llmConfig,
        onUsage: async (metadata) => {
          const collectedUsage = mapCollectedMetadataToUsage(metadata).map((usage) => ({
            ...usage,
            provider: model.llmConfig.provider,
          }));
          if (!collectedUsage.length) return;
          await onBilling('started');
          let failure: Error | undefined;
          const pending: Promise<unknown>[] = [];
          const track =
            <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
            (...args: A): Promise<R> => {
              const promise = fn(...args).catch((error) => {
                failure = error instanceof Error ? error : new Error('Abrechnung fehlgeschlagen.');
                throw error;
              });
              pending.push(promise);
              return promise;
            };
          await recordCollectedUsage(
            {
              ...deps.usage,
              spendTokens: track(deps.usage.spendTokens),
              spendStructuredTokens: track(deps.usage.spendStructuredTokens),
              ...(deps.usage.bulkWriteOps
                ? {
                    bulkWriteOps: {
                      insertMany: track(deps.usage.bulkWriteOps.insertMany),
                      updateBalance: track(deps.usage.bulkWriteOps.updateBalance),
                    },
                  }
                : {}),
            },
            {
              user: String(fresh.user!.id),
              conversationId: source.conversationId,
              messageId: source.messageId,
              model: model.llmConfig.model,
              context: 'brain',
              balance: getBalanceConfig(fresh.config),
              transactions: getTransactionsConfig(fresh.config),
              endpointTokenConfig: model.endpointTokenConfig,
              collectedUsage,
            },
          );
          await Promise.allSettled(pending);
          if (failure)
            throw new BrainHistoryError(
              'Die Modellnutzung konnte nicht abschliessend verbucht werden. Beim Fortsetzen wird diese Buchung nicht doppelt ausgelöst; die Administration sollte sie prüfen.',
              'billing',
            );
          await onBilling('complete');
        },
      });
      if (!checkpointed)
        throw new BrainHistoryError(
          'Die Modellprüfung konnte nicht abgeschlossen werden. Bitte versuche es erneut.',
        );
    },
    async ingest({ req, source, text, facts, canContinue, rebuildId }) {
      if (!facts.length) return 0;
      if (!(await canContinue()))
        throw new BrainHistoryError(
          'Die Originalquelle oder die Berechtigung ist nicht mehr verfügbar.',
        );
      if (source.messages) {
        const knownIds = new Set(
          facts.flatMap((fact) => [
            ...(fact.relatedIds ?? []),
            ...(fact.supersedesId ? [fact.supersedesId] : []),
          ]),
        );
        const valid = validateContextualFacts(facts, source.messages, knownIds);
        const batches: object[] = [];
        let position = 0;
        while (position < valid.length) {
          let size = Math.min(40, valid.length - position);
          while (size > 0) {
            const batch = valid.slice(position, position + size);
            const evidenceIds = new Set(
              batch.flatMap((fact) => fact.evidence?.map((entry) => entry.messageId) ?? []),
            );
            const input = {
              conversationId: source.conversationId,
              historical: true,
              generationId: rebuildId,
              sourceMessages: source.messages.map(
                ({ parentId: _parent, text: content, ...message }) => ({
                  ...message,
                  ...(evidenceIds.has(message.id) ? { text: content } : {}),
                }),
              ),
              facts: batch.map(({ quote: _quote, ...fact }) => ({
                ...fact,
                text: fact.text!,
                title: fact.title ?? fact.text!.slice(0, 90),
                sourceMessageIds: source.messages!.map((message) => message.id),
              })),
            };
            const body = {
              ...input,
              requestId: `history-v2:${conversationHash(JSON.stringify(input))}`,
            };
            if (Buffer.byteLength(JSON.stringify(body), 'utf8') < 1_900_000) {
              batches.push(body);
              break;
            }
            size = Math.floor(size / 2);
          }
          if (!size)
            throw new BrainHistoryError(
              'Die Belege einer Erinnerung sind zu umfangreich für die sichere Übernahme. Der geprüfte Zwischenstand bleibt erhalten.',
            );
          position += size;
        }
        let created = 0;
        for (const body of batches) {
          if (!(await canContinue()))
            throw new BrainHistoryError('Gespräch oder Berechtigung wurde inzwischen geändert.');
          const result = await requestBrain<{ created?: number; nodes: BrainNode[] }>(
            String(req.user!.id),
            'POST',
            '/v1/ingest',
            body,
            120_000,
          );
          created += result.created ?? result.nodes.length;
        }
        return created;
      }
      const session = sessionFor(req, source, text, canContinue);
      const references = [...new Set(facts.flatMap((fact) => fact.relatedIds ?? []))];
      await Promise.all(
        references.map(async (id) => {
          try {
            await requestBrain(String(req.user!.id), 'GET', `/v1/nodes/${encodeURIComponent(id)}`);
            session.knownIds.add(id);
          } catch (error) {
            if (!(error instanceof BrainServiceError) || error.status !== 404) throw error;
          }
        }),
      );
      const result = await session.remember(
        facts.map((fact) => ({
          ...fact,
          relatedIds: fact.relatedIds?.filter((id) => session.knownIds.has(id)),
        })),
        true,
      );
      if (result.error) throw new BrainHistoryError(result.error);
      return result.created ?? result.nodes.length;
    },
    async complete(req, rebuildId) {
      await refresh(req);
      await requestBrain(
        String(req.user!.id),
        'POST',
        `/v1/rebuild/${encodeURIComponent(rebuildId)}/complete`,
        {},
        120_000,
      );
    },
  };
  return processor;
}

export function createBrainHistoryRuntime(
  deps: BrainHistoryRuntimeDependencies,
): BrainHistoryService {
  return createBrainHistoryService({
    store: deps.store,
    reportFailure: deps.reportFailure,
    processor: createBrainHistoryProcessor(deps),
  });
}
