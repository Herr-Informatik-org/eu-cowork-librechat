import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { LLMConfig, OpenAIClientOptions } from '@librechat/agents';
import type { EndpointDbMethods, EndpointTokenConfig, ServerRequest } from '~/types';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveConfigHeaders } from '~/utils/headers';
import { createSafeUser } from '~/utils/env';

export class BrainLearningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainLearningConfigurationError';
  }
}

export interface BrainLearningModelOptions {
  req: ServerRequest;
  agent: {
    provider: string;
    model?: string;
    model_parameters?: Record<string, unknown>;
  };
  ids: { conversationId: string; messageId: string };
  endpointTokenConfig?: EndpointTokenConfig;
  db: EndpointDbMethods;
}

export interface BrainLearningModel {
  llmConfig: LLMConfig;
  endpointTokenConfig?: EndpointTokenConfig;
}

/** Resolve the selected connection from trusted configuration, never from chat-model credentials. */
export async function resolveBrainLearningModel({
  req,
  agent,
  ids,
  endpointTokenConfig,
  db,
}: BrainLearningModelOptions): Promise<BrainLearningModel | null> {
  const configured = req.config?.memory?.agent;
  if (configured?.enabled === false) {
    return null;
  }
  let llmConfig: LLMConfig & { configuration?: OpenAIClientOptions['configuration'] };
  let targetPricing = endpointTokenConfig;
  if (configured == null) {
    llmConfig = {
      ...agent.model_parameters,
      provider: agent.provider as Providers,
      model: String(agent.model_parameters?.model ?? agent.model ?? ''),
    };
  } else {
    if (!('provider' in configured) || !('model' in configured)) {
      throw new BrainLearningConfigurationError(
        'id' in configured
          ? 'Brain unterstützt memory.agent.id nicht. Bitte unter Modelle → Brain einen Anbieter und ein Modell auswählen.'
          : 'Für das Brain-Lernmodell sind Anbieter und Modell erforderlich.',
      );
    }
    const endpoint = configured.provider?.trim();
    const model = configured.model?.trim();
    if (!endpoint || !model) {
      throw new BrainLearningConfigurationError(
        'Für das Brain-Lernmodell sind Anbieter und Modell erforderlich.',
      );
    }
    const allowed = req.config?.endpoints?.agents?.allowedProviders;
    if (allowed?.length && !allowed.includes(endpoint)) {
      throw new BrainLearningConfigurationError(
        'Der Anbieter des Brain-Lernmodells ist für Agenten nicht freigegeben.',
      );
    }
    try {
      const providerConfig = getProviderConfig({ provider: endpoint, appConfig: req.config });
      const options = await providerConfig.getOptions({
        req,
        endpoint,
        model_parameters: { ...configured.model_parameters, model },
        db,
      });
      let provider = (options.provider ?? providerConfig.overrideProvider) as Providers;
      const resolved = options.llmConfig as LLMConfig & { azureOpenAIApiInstanceName?: string };
      if (endpoint === EModelEndpoint.azureOpenAI) {
        provider = resolved.azureOpenAIApiInstanceName == null ? Providers.OPENAI : Providers.AZURE;
      }
      llmConfig = { ...resolved, provider, model: resolved.model ?? model };
      if (options.configOptions) {
        llmConfig.configuration = options.configOptions;
      }
      targetPricing = options.endpointTokenConfig;
    } catch (error) {
      if (error instanceof BrainLearningConfigurationError) throw error;
      throw new BrainLearningConfigurationError(
        'Das konfigurierte Brain-Lernmodell ist nicht verfügbar. Bitte Anbieter, Modell und Zugangsdaten unter Modelle → Brain prüfen. Es wird kein Ersatzanbieter verwendet.',
      );
    }
  }
  // Copy only mutable header carriers; preserve SDK transport guards and dispatchers.
  if (llmConfig.configuration) llmConfig.configuration = { ...llmConfig.configuration };
  const native = llmConfig as LLMConfig & { clientOptions?: Record<string, unknown> };
  if (native.clientOptions) native.clientOptions = { ...native.clientOptions };
  resolveConfigHeaders({ llmConfig, user: createSafeUser(req.user), body: ids });
  return { llmConfig, endpointTokenConfig: targetPricing };
}
