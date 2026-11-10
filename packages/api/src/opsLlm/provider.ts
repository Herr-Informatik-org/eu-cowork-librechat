import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppConfig, IAgent } from '@librechat/data-schemas';
import type { CompletionInput, OpsConfig } from './config';
import { resolveConfigSecret, resolveCustomEndpointSecrets } from '~/admin/secrets';
import { OpsLlmError, hasNoControlCharacters } from './config';

export interface ModelDependencies {
  getCentralConfig: () => Promise<AppConfig>;
  getCentralAgent: (id: string) => Promise<IAgent | null>;
  fetch?: typeof fetch;
}
interface ProviderRouting {
  only?: string[];
  ignore?: string[];
  order?: string[];
  allow_fallbacks?: boolean;
  data_collection?: 'allow' | 'deny';
  require_parameters?: boolean;
  zdr?: boolean;
  quantizations?: string[];
  sort?: 'price' | 'throughput' | 'latency';
  max_price?: { prompt?: number; completion?: number };
}
export interface OpsModel {
  model: string;
  label: string;
  baseURL: string;
  key: string;
  fingerprint?: string;
  jsonObject: boolean;
  upstream: string;
  routing: ProviderRouting;
}
export interface OpsCompletion {
  model: string;
  text: string;
  finishReason: 'stop' | 'length';
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
export interface OpsProvider {
  resolve(config: OpsConfig, signal: AbortSignal): Promise<OpsModel>;
  complete(config: OpsConfig, input: CompletionInput, signal: AbortSignal): Promise<OpsCompletion>;
}
const gatewayURL = 'http://mcp-gateway:3020/router/v1/direct';
const routingSchema = z
  .object({
    only: z
      .array(z.string().min(1).max(100).refine(hasNoControlCharacters))
      .min(1)
      .max(30)
      .optional(),
    ignore: z
      .array(z.string().min(1).max(100).refine(hasNoControlCharacters))
      .min(1)
      .max(30)
      .optional(),
    order: z
      .array(z.string().min(1).max(100).refine(hasNoControlCharacters))
      .min(1)
      .max(30)
      .optional(),
    allow_fallbacks: z.boolean().optional(),
    data_collection: z.enum(['allow', 'deny']).optional(),
    require_parameters: z.boolean().optional(),
    zdr: z.boolean().optional(),
    quantizations: z.array(z.string().min(1).max(30)).min(1).max(30).optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
    max_price: z
      .object({
        prompt: z.number().nonnegative().optional(),
        completion: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const diagnosticSchema = z.object({
  profile: z.literal('direct'),
  models: z.object({ default: z.string() }),
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  hasUpstreamKey: z.literal(true),
  upstream: z.object({
    baseURL: z.string(),
    openrouterBody: z.boolean(),
  }),
  opsText: z.object({
    version: z.literal(1),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    noRetention: z.literal(true),
    jsonObject: z.literal(true),
    noContentLogging: z.literal(true),
  }),
});
const responseSchema = z.object({
  model: z.string().min(1).max(200),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().max(524288),
          tool_calls: z.never().optional(),
          function_call: z.never().optional(),
        }),
        finish_reason: z.enum(['stop', 'length']),
      }),
    )
    .length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().max(1000000),
    completion_tokens: z.number().int().nonnegative().max(1000000),
    total_tokens: z.number().int().nonnegative().max(2000000),
  }),
});
export async function boundedJSON(response: Response, maximum = 1048576): Promise<unknown> {
  if (!response.body)
    throw new OpsLlmError(
      502,
      'invalid_upstream_response',
      'Das Modell hat keine Antwort geliefert.',
    );
  const reader = response.body.getReader();
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum)
        throw new OpsLlmError(502, 'invalid_upstream_response', 'Die Modellantwort ist zu gross.');
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createOpsProvider(
  deps: ModelDependencies,
  now: () => number = Date.now,
): OpsProvider {
  const request = deps.fetch ?? fetch;
  async function resolve(config: OpsConfig, signal: AbortSignal) {
    const policy = config.policy;
    if (
      !policy ||
      Date.parse(policy.reviewedAt) > now() ||
      Date.parse(policy.expiresAt) <= now() ||
      Date.parse(policy.expiresAt) <= Date.parse(policy.reviewedAt)
    )
      throw new OpsLlmError(
        503,
        'provider_not_verified',
        'Für das Standardmodell fehlt eine gültige bestätigte Datenschutzfreigabe.',
      );
    const app = await deps.getCentralConfig();
    const specs = app.modelSpecs?.list ?? [];
    const defaults = specs.filter((item) => item.default === true);
    const selected = defaults.length ? defaults : specs.filter((item) => item.softDefault === true);
    if (selected.length !== 1 || selected[0].showInMenu === false)
      throw new OpsLlmError(
        503,
        'model_not_available',
        'Das zentrale Standardmodell ist nicht eindeutig verfügbar.',
      );
    const preset = selected[0].preset;
    let provider = preset?.endpoint;
    let model = preset?.model;
    if (provider === 'agents') {
      const agent =
        typeof preset?.agent_id === 'string' ? await deps.getCentralAgent(preset.agent_id) : null;
      if (!agent || agent.tenantId != null)
        throw new OpsLlmError(
          503,
          'model_not_available',
          'Der zentrale Standardagent ist nicht verfügbar.',
        );
      provider = agent.provider;
      model = agent.model;
      if (typeof agent.model_parameters?.model === 'string') model = agent.model_parameters.model;
      if (typeof preset?.model === 'string') model = preset.model;
    }
    if (
      !model ||
      model !== policy.model ||
      /^(?:auto|eu-auto|openrouter\/auto|openrouter\/free)$/i.test(model) ||
      /:online$/i.test(model)
    )
      throw new OpsLlmError(
        503,
        'model_not_verified',
        'Das aktuelle Standardmodell ist nicht für diese Schnittstelle freigegeben.',
      );
    const matches = (app.endpoints?.custom ?? []).filter((item) => item.name === provider);
    const endpoint = matches.length === 1 ? resolveCustomEndpointSecrets(matches[0]) : undefined;
    const baseURL = resolveConfigSecret(endpoint?.baseURL)?.replace(/\/$/, '');
    const key = resolveConfigSecret(endpoint?.apiKey);
    if (
      !endpoint ||
      !baseURL ||
      !key ||
      key === 'user_provided' ||
      key.includes('${') ||
      (baseURL !== gatewayURL && baseURL !== policy.baseURL)
    )
      throw new OpsLlmError(
        503,
        'provider_not_verified',
        'Die zentrale Modellverbindung ist nicht freigegeben.',
      );
    if (
      Object.keys(endpoint.addParams ?? {}).some((field) => !['provider', 'store'].includes(field))
    )
      throw new OpsLlmError(
        503,
        'unsupported_model_parameters',
        'Die zentrale Route enthält zusätzliche nicht freigegebene Parameter.',
      );
    if (
      baseURL !== gatewayURL &&
      createHash('sha256').update(key).digest('hex') !== policy.credentialFingerprint
    )
      throw new OpsLlmError(
        503,
        'provider_not_verified',
        'Der aktuelle Anbieterzugang wurde noch nicht für diese Schnittstelle bestätigt.',
      );
    const routing = routingSchema.safeParse(endpoint.addParams?.provider ?? {});
    if (
      !routing.success ||
      (policy.baseURL !== 'https://openrouter.ai/api/v1' && Object.keys(routing.data).length)
    )
      throw new OpsLlmError(
        503,
        'unsupported_model_parameters',
        'Die zentrale Datenschutzroute enthält nicht unterstützte Vorgaben.',
      );
    if (
      baseURL === gatewayURL &&
      ['quantizations', 'sort', 'max_price'].some((field) => field in routing.data)
    )
      throw new OpsLlmError(
        503,
        'unsupported_model_parameters',
        'Das geschützte Gateway unterstützt diese zusätzliche Modellvorgabe nicht.',
      );
    const allowed = app.endpoints?.agents?.allowedProviders;
    if (allowed?.length && (!provider || !allowed.includes(provider)))
      throw new OpsLlmError(503, 'model_not_available', 'Das zentrale Modell ist gesperrt.');
    let fingerprint: string | undefined;
    if (baseURL === gatewayURL) {
      const response = await request(
        `http://mcp-gateway:3020/router/v1/diagnostics?mode=direct&model=${encodeURIComponent(model)}`,
        { method: 'GET', redirect: 'error', signal },
      );
      if (!response.ok)
        throw new OpsLlmError(
          503,
          'gateway_not_verified',
          'Die zentrale Modellroute kann nicht geprüft werden.',
        );
      const parsed = diagnosticSchema.safeParse(await boundedJSON(response, 65536));
      if (
        !parsed.success ||
        parsed.data.models.default !== model ||
        parsed.data.upstream.baseURL !== policy.baseURL ||
        parsed.data.opsText.credentialFingerprint !== policy.credentialFingerprint ||
        parsed.data.upstream.openrouterBody !== (policy.baseURL === 'https://openrouter.ai/api/v1')
      )
        throw new OpsLlmError(
          503,
          'gateway_not_verified',
          'Die zentrale Modellroute unterstützt den geschützten OPS-Modus noch nicht.',
        );
      fingerprint = parsed.data.opsText.policyFingerprint;
    }
    return {
      model,
      label: typeof selected[0].label === 'string' ? selected[0].label.slice(0, 200) : model,
      baseURL,
      key,
      fingerprint,
      jsonObject: policy.jsonObject,
      upstream: policy.baseURL,
      routing: routing.data,
    };
  }
  return {
    resolve,
    async complete(config: OpsConfig, input: CompletionInput, signal: AbortSignal) {
      const output =
        input.max_completion_tokens ??
        input.max_tokens ??
        Math.min(1500, config.limits.outputTokens);
      if (output > config.limits.outputTokens)
        throw new OpsLlmError(400, 'output_limit_exceeded', 'Das Ausgabelimit ist zu hoch.');
      // UTF-8 bytes are a conservative token bound across the supported byte-token models.
      const upperInputBound = input.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 16,
        16,
      );
      if (upperInputBound > config.limits.inputTokens)
        throw new OpsLlmError(
          400,
          'input_limit_exceeded',
          'Der Text ist zu umfangreich. Bitte die Anfrage eingrenzen.',
        );
      const selected = await resolve(config, signal);
      if (input.response_format && !selected.jsonObject)
        throw new OpsLlmError(
          400,
          'json_not_supported',
          'JSON-Ausgaben sind für das Standardmodell nicht bestätigt.',
        );
      const response = await request(`${selected.baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${selected.key}`,
          'Content-Type': 'application/json',
          ...(selected.fingerprint
            ? {
                'X-EUCowork-OPS-Text': 'true',
                'X-EUCowork-Route-Fingerprint': selected.fingerprint,
              }
            : {}),
        },
        body: JSON.stringify({
          model: selected.model,
          messages: input.messages,
          stream: false,
          store: false,
          max_completion_tokens: output,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.response_format ? { response_format: input.response_format } : {}),
          ...(selected.upstream === 'https://openrouter.ai/api/v1'
            ? {
                provider: {
                  ...selected.routing,
                  zdr: true,
                  data_collection: 'deny',
                  allow_fallbacks: false,
                  require_parameters: true,
                },
              }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpsLlmError(
          response.status === 429 ? 429 : 502,
          'upstream_unavailable',
          'Das freigegebene Modell ist derzeit nicht verfügbar. Es wurde kein Ersatzanbieter verwendet.',
          response.status === 429 ? 30 : undefined,
        );
      }
      const result = responseSchema.safeParse(await boundedJSON(response));
      if (!result.success)
        throw new OpsLlmError(
          502,
          'invalid_upstream_response',
          'Das Modell hat keine gültige Textantwort mit Verbrauchsdaten geliefert.',
        );
      const data = result.data;
      if (data.model !== selected.model)
        throw new OpsLlmError(
          502,
          'unexpected_model',
          'Das Modell der Antwort stimmt nicht mit der freigegebenen Route überein.',
        );
      if (data.usage.completion_tokens > output)
        throw new OpsLlmError(
          502,
          'invalid_upstream_response',
          'Das Modell hat das vereinbarte Ausgabelimit überschritten.',
        );
      if (data.usage.total_tokens !== data.usage.prompt_tokens + data.usage.completion_tokens)
        throw new OpsLlmError(
          502,
          'invalid_upstream_response',
          'Die Verbrauchsdaten der Modellantwort sind ungültig.',
        );
      if (input.response_format) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.choices[0].message.content);
        } catch {
          throw new OpsLlmError(
            502,
            'invalid_json_response',
            'Das Modell hat kein gültiges JSON-Objekt geliefert.',
          );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new OpsLlmError(
            502,
            'invalid_json_response',
            'Das Modell hat kein JSON-Objekt geliefert.',
          );
      }
      return {
        model: data.model,
        text: data.choices[0].message.content,
        finishReason: data.choices[0].finish_reason,
        usage: data.usage,
      };
    },
  };
}
