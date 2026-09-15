import { createHash, createHmac, randomUUID } from 'node:crypto';

const serviceCodes = [
  'invalid_request',
  'version_conflict',
  'request_conflict',
  'rebuild_state',
  'stale_sources',
  'source_manifest_state',
  'deleted_source',
  'stale_edit',
  'ambiguous_edit',
  'rollback_expired',
  'not_found',
  'unauthorized',
  'replayed',
  'unconfigured',
  'payload_too_large',
] as const;
const validationFields = [
  'requestId',
  'conversationId',
  'generationId',
  'sourceManifestId',
  'sourceCount',
  'pageCount',
  'pageIndex',
  'sourceMessages',
  'sourceMessages.id',
  'sourceMessages.text',
  'sourceMessages.role',
  'sourceMessages.contentHash',
  'sourceMessages.createdAt',
  'sourceMessageIds',
  'facts',
  'facts.title',
  'facts.text',
  'facts.kind',
  'facts.scope',
  'facts.tags',
  'facts.evidence',
  'facts.evidence.messageId',
  'facts.evidence.quote',
  'facts.sourceMessageIds',
  'facts.relatedIds',
  'facts.supersedesId',
  'facts.expectedVersion',
  'facts.basis',
  'facts.claimState',
  'facts.validFrom',
  'facts.validUntil',
  'version',
  'historical',
  'explicit',
  'title',
  'text',
  'kind',
  'scope',
  'tags',
  'relatedIds',
  'supersedesId',
  'expectedVersion',
  'basis',
  'claimState',
  'validFrom',
  'validUntil',
  'body',
  'node',
  'pinned',
  'status',
  'facts.pinned',
  'facts.status',
] as const;

const validationReasons = [
  'required',
  'invalid_type',
  'empty',
  'too_long',
  'too_many',
  'invalid_format',
  'invalid_value',
  'duplicate',
  'source_mismatch',
  'not_grounded',
  'incompatible_sources',
  'out_of_range',
] as const;

export interface BrainServiceDiagnostic {
  serviceCode?: (typeof serviceCodes)[number];
  validationField?: (typeof validationFields)[number];
  validationReason?: (typeof validationReasons)[number];
}

/** Accept protocol constants only, never exception messages or user-controlled field paths. */
export function safeBrainServiceDiagnostic(value: unknown): BrainServiceDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { code, field, reason } = value as Record<string, unknown>;
  return {
    ...(typeof code === 'string' && (serviceCodes as readonly string[]).includes(code)
      ? { serviceCode: code as BrainServiceDiagnostic['serviceCode'] }
      : {}),
    ...(typeof field === 'string' && (validationFields as readonly string[]).includes(field)
      ? { validationField: field as BrainServiceDiagnostic['validationField'] }
      : {}),
    ...(typeof reason === 'string' && (validationReasons as readonly string[]).includes(reason)
      ? { validationReason: reason as BrainServiceDiagnostic['validationReason'] }
      : {}),
  };
}

/** Error bodies are untrusted and may contain prompts; read at most 4 KiB and retain constants only. */
async function readBrainServiceDiagnostic(response: Response): Promise<BrainServiceDiagnostic> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return {};
      chunks.push(value);
    }
    return safeBrainServiceDiagnostic(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return {};
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class BrainServiceError extends Error implements BrainServiceDiagnostic {
  public serviceCode?: BrainServiceDiagnostic['serviceCode'];
  public validationField?: BrainServiceDiagnostic['validationField'];
  public validationReason?: BrainServiceDiagnostic['validationReason'];

  constructor(
    public status: number,
    message = 'Das Brain ist zurzeit nicht erreichbar.',
    public upstreamStatus?: number,
    public cause?: unknown,
    diagnostic?: BrainServiceDiagnostic,
  ) {
    super(message);
    this.name = 'BrainServiceError';
    Object.assign(
      this,
      safeBrainServiceDiagnostic({
        code: diagnostic?.serviceCode,
        field: diagnostic?.validationField,
        reason: diagnostic?.validationReason,
      }),
    );
  }
}

export function isBrainConfigured(): boolean {
  return Boolean(process.env.BRAIN_API_URL && process.env.BRAIN_SHARED_SECRET);
}

export function signBrainRequest({
  method,
  path,
  userId,
  body,
  secret,
  timestamp = String(Date.now()),
  nonce = randomUUID(),
}: {
  method: string;
  path: string;
  userId: string;
  body: string;
  secret: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update([method.toUpperCase(), path, timestamp, nonce, userId, digest].join('\n'))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-brain-user': userId,
    'x-brain-timestamp': timestamp,
    'x-brain-nonce': nonce,
    'x-brain-signature': signature,
  };
}

export async function requestBrain<T>(
  userId: string,
  method: string,
  path: string,
  payload?: object,
  timeoutMs = 5000,
): Promise<T> {
  const baseUrl = process.env.BRAIN_API_URL;
  const secret = process.env.BRAIN_SHARED_SECRET;
  if (!baseUrl || !secret || !userId || !path.startsWith('/v1/')) {
    throw new BrainServiceError(503);
  }
  const body = payload === undefined ? '' : JSON.stringify(payload);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: signBrainRequest({ method, path, userId, body, secret }),
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const diagnostic = await readBrainServiceDiagnostic(response);
      const messages: Record<number, string> = {
        400: 'Die Brain-Anfrage ist ungültig.',
        403: 'Dieser Brain-Zugriff ist nicht erlaubt.',
        404: 'Dieser Brain-Eintrag wurde nicht gefunden.',
        409: 'Der Brain-Stand wurde inzwischen geändert. Bitte lade ihn erneut.',
        413: 'Die Brain-Anfrage ist zu umfangreich.',
        422: 'Die Brain-Daten konnten nicht verarbeitet werden.',
        429: 'Der Brain-Dienst begrenzt gerade die Anfragen. Bitte warte kurz.',
      };
      throw new BrainServiceError(
        messages[response.status] ? response.status : 503,
        messages[response.status],
        response.status,
        undefined,
        diagnostic,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof BrainServiceError) {
      throw error;
    }
    throw new BrainServiceError(503, undefined, undefined, error);
  }
}

export async function deleteBrainSources(
  userId: string,
  conversationIds: string[],
  messageIds?: string[],
): Promise<void> {
  if (!process.env.BRAIN_API_URL || conversationIds.length === 0) {
    return;
  }
  await requestBrain(userId, 'DELETE', '/v1/sources', { conversationIds, messageIds });
}
