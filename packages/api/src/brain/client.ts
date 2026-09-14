import { createHash, createHmac, randomUUID } from 'node:crypto';

export class BrainServiceError extends Error {
  constructor(
    public status: number,
    message = 'Das Brain ist zurzeit nicht erreichbar.',
    public upstreamStatus?: number,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'BrainServiceError';
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
      await response.body?.cancel();
      const messages: Record<number, string> = {
        400: 'Die Brain-Anfrage ist ungültig.',
        403: 'Dieser Brain-Zugriff ist nicht erlaubt.',
        404: 'Dieser Brain-Eintrag wurde nicht gefunden.',
        409: 'Der Eintrag wurde inzwischen geändert. Bitte lade ihn erneut.',
      };
      throw new BrainServiceError(
        messages[response.status] ? response.status : 503,
        messages[response.status],
        response.status,
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
