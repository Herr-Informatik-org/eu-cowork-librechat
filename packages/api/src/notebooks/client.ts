import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ZodType, output } from 'zod';

export interface NotebookActor {
  id: string;
  role: 'ADMIN' | 'USER';
  room: string;
  permissions: number;
}

export class NotebookError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function notebooksEnabled(): boolean {
  return process.env.NOTEBOOKS_ENABLED === 'true';
}

export async function notebookRequest<S extends ZodType>(
  actor: NotebookActor,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  schema: S,
  payload?: object,
): Promise<output<S>> {
  if (!notebooksEnabled()) throw new NotebookError(404, 'Wissensräume sind nicht aktiviert.');
  const base = process.env.NOTEBOOKS_URL ?? '';
  if (!/^http:\/\/notebooks(?:-next)?:[0-9]+$/.test(base))
    throw new NotebookError(503, 'Der Wissensraumdienst ist nicht eingerichtet.');
  const secret = readFileSync(process.env.NOTEBOOKS_KEY_FILE ?? '', 'utf8').trim();
  if (secret.length < 32) throw new NotebookError(503, 'Der Wissensraumschlüssel fehlt.');
  const body = payload ? JSON.stringify(payload) : '';
  const fields = [
    String(Math.floor(Date.now() / 1000)),
    randomBytes(16).toString('hex'),
    process.env.NOTEBOOKS_TENANT ?? 'cwv01',
    actor.id,
    actor.role,
    actor.room,
    String(actor.permissions),
  ];
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([method, path, ...fields, digest].join('\n'))
    .digest('hex');
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(100_000),
      headers: {
        'Content-Type': 'application/json',
        ...Object.fromEntries(
          ['time', 'nonce', 'tenant', 'user', 'role', 'room', 'permissions'].map((key, index) => [
            `x-kisuno-${key}`,
            fields[index],
          ]),
        ),
        'x-kisuno-signature': signature,
      },
      ...(body ? { body } : {}),
    });
  } catch {
    throw new NotebookError(503, 'Der Wissensraumdienst ist nicht erreichbar.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NotebookError(503, 'Der Wissensraumdienst liefert keine Antwort.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 2_000_000) throw new Error();
      parts.push(next.value);
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (!response.ok) {
      let detail:string|undefined;
      try { const value=JSON.parse(text);const candidate=value.detail ?? value.error;if(typeof candidate==='string' && candidate.length<=500 && !/[\x00-\x1f]/.test(candidate))detail=candidate; } catch {}
      throw new NotebookError(
        response.status >= 500 ? 503 : response.status,
        detail ?? 'Die Operation ist nicht freigegeben oder kann gerade nicht sicher abgeschlossen werden. Quelle und Prüfstand kontrollieren.',
      );
    }
    return schema.parse(JSON.parse(text));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof NotebookError) throw error;
    throw new NotebookError(503, 'Ungültige Antwort des Wissensraumdienstes.');
  }
}
