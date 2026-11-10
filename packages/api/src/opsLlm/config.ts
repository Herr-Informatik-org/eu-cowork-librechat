import { z } from 'zod';

export interface CompletionInput {
  model: 'kisuno-default';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_object' };
  stream?: false;
}
interface MailSource {
  sender: string;
  subject: string;
  text: string;
}
interface PersonalInput {
  task: 'mail_draft' | 'mail_review';
  instruction: string;
  mail: MailSource & {
    history?: MailSource[];
    attachments?: { name: string; content_type: string; size_bytes: number }[];
  };
  skill_ids: string[];
  brain: boolean;
  background: boolean;
  max_output_tokens: number;
}
type PersonalRequest = Omit<
  PersonalInput,
  'skill_ids' | 'brain' | 'background' | 'max_output_tokens'
> &
  Partial<Pick<PersonalInput, 'skill_ids' | 'brain' | 'background' | 'max_output_tokens'>>;
export interface KeyInput {
  name: string;
  modules: string[];
}
export interface ProviderPolicy {
  baseURL:
    | 'https://api.eurouter.ai/api/v1'
    | 'https://api.tensorx.ai/v1'
    | 'https://openrouter.ai/api/v1';
  model: string;
  noRetention: true;
  credentialFingerprint: string;
  jsonObject: boolean;
  reviewedAt: string;
  expiresAt: string;
  reference: string;
}
export function hasNoControlCharacters(value: string): boolean {
  return !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
export class OpsLlmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(131072),
  })
  .strict();
export const completionSchema: z.ZodType<CompletionInput> = z
  .object({
    model: z.literal('kisuno-default'),
    messages: z.array(messageSchema).min(1).max(100),
    max_tokens: z.number().int().min(1).max(8192).optional(),
    max_completion_tokens: z.number().int().min(1).max(8192).optional(),
    temperature: z.number().min(0).max(2).optional(),
    response_format: z
      .object({ type: z.literal('json_object') })
      .strict()
      .optional(),
    stream: z.literal(false).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.max_tokens && value.max_completion_tokens),
    'Nur ein Ausgabelimit angeben.',
  );
const mailText = z
  .string()
  .max(40000)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 40000);
const mailSourceSchema = z
  .object({
    sender: z.string().email().max(320),
    subject: z.string().max(500),
    text: mailText,
  })
  .strict();
export const personalSchema: z.ZodType<PersonalInput, z.ZodTypeDef, PersonalRequest> = z
  .object({
    task: z.enum(['mail_draft', 'mail_review']),
    instruction: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 4000),
    mail: mailSourceSchema
      .extend({
        history: z.array(mailSourceSchema).max(10).optional(),
        attachments: z
          .array(
            z
              .object({
                name: z.string().min(1).max(200),
                content_type: z.string().min(1).max(100),
                size_bytes: z.number().int().nonnegative().max(1073741824),
              })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict(),
    skill_ids: z.array(z.string().min(1).max(200)).max(8).default([]),
    brain: z.boolean().default(false),
    background: z.boolean().default(false),
    max_output_tokens: z.number().int().min(1).max(8192).default(1500),
  })
  .strict()
  .refine(
    (value) => !value.background || value.task === 'mail_review',
    'Hintergrundaufträge dürfen nur prüfen, keine Entwürfe erstellen.',
  );
export const keySchema: z.ZodType<KeyInput> = z
  .object({
    name: z.string().trim().min(1).max(100).refine(hasNoControlCharacters),
    modules: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
      .min(1)
      .max(20)
      .refine((items) => new Set(items).size === items.length),
  })
  .strict();
export const policySchema: z.ZodType<ProviderPolicy> = z
  .object({
    baseURL: z.enum([
      'https://api.eurouter.ai/api/v1',
      'https://api.tensorx.ai/v1',
      'https://openrouter.ai/api/v1',
    ]),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
    noRetention: z.literal(true),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    jsonObject: z.boolean(),
    reviewedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    reference: z.string().min(1).max(300),
  })
  .strict();
export interface Limits {
  bodyBytes: number;
  inputTokens: number;
  outputTokens: number;
  timeoutMs: number;
  parallel: number;
  rpm: number;
  globalParallel: number;
  globalRpm: number;
}
export interface OpsConfig {
  enabled: boolean;
  limits: Limits;
  policy?: ProviderPolicy;
}
export function readOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new OpsLlmError(503, 'configuration_error', 'Die OPS-Limits sind ungültig.');
    return value;
  };
  const enabled =
    env.KISUNO_OPS_INTERNAL_ENABLED === 'true' && env.KISUNO_OPS_TENANT_ID === 'cwv01';
  let policy: ProviderPolicy | undefined;
  if (env.KISUNO_OPS_PROVIDER_POLICY_JSON) {
    try {
      policy = policySchema.parse(JSON.parse(env.KISUNO_OPS_PROVIDER_POLICY_JSON));
    } catch {
      throw new OpsLlmError(
        503,
        'configuration_error',
        'Die bestätigte Datenschutzfreigabe ist ungültig.',
      );
    }
  }
  return {
    enabled,
    policy,
    limits: {
      bodyBytes: 262144,
      inputTokens: integer('KISUNO_OPS_INPUT_TOKENS', 32768, 1024, 32768),
      outputTokens: integer('KISUNO_OPS_OUTPUT_TOKENS', 8192, 128, 8192),
      timeoutMs: integer('KISUNO_OPS_TIMEOUT_MS', 120000, 1000, 120000),
      parallel: integer('KISUNO_OPS_PARALLEL', 2, 1, 4),
      rpm: integer('KISUNO_OPS_RPM', 30, 1, 120),
      globalParallel: integer('KISUNO_OPS_GLOBAL_PARALLEL', 4, 1, 16),
      globalRpm: integer('KISUNO_OPS_GLOBAL_RPM', 60, 1, 600),
    },
  };
}
export function assertEnabled(config: OpsConfig): void {
  if (!config.enabled)
    throw new OpsLlmError(404, 'not_available', 'Diese Schnittstelle ist hier nicht freigegeben.');
}
