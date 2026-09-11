import mongoose from 'mongoose';
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export type UsageCreditPolicy = {
  plan: 'trial' | 'paid';
  trialStartedAt: Date;
  trialCreditChf: number;
  usdChfRate: number;
};

export function creditExhausted(policy: UsageCreditPolicy, usdMicros: number): boolean {
  if (policy.plan === 'paid') return false;
  if (
    policy.plan !== 'trial' ||
    !Number.isFinite(policy.usdChfRate) ||
    policy.usdChfRate <= 0 ||
    !Number.isFinite(policy.trialCreditChf) ||
    policy.trialCreditChf < 0 ||
    !Number.isFinite(usdMicros) ||
    usdMicros < 0
  )
    throw new Error('Ungültige Guthabenkonfiguration.');
  return usdMicros * policy.usdChfRate >= policy.trialCreditChf * 1e6;
}

export async function assertUsageCredit(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Die Guthabenprüfung ist momentan nicht verfügbar.');
  const policy = await db
    .collection<UsageCreditPolicy & { _id: string }>('eucowork_hosted')
    .findOne({ _id: 'subscription' });
  if (!policy) {
    if (process.env.HOSTED_USAGE_REQUIRED === 'true')
      throw new Error('Die Testumgebung wird noch eingerichtet.');
    return;
  }
  if (policy.plan === 'paid') return;
  if (!process.env.JWT_SECRET) throw new Error('Die Guthabenprüfung ist nicht konfiguriert.');
  const token = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update('eucowork-usage-credit')
    .digest('hex');
  const response = await fetch(
    process.env.USAGE_CREDIT_URL || 'http://admin:3010/api/usage-credit/check',
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );
  if (!response.ok)
    throw new Error('Die Guthabenprüfung ist momentan nicht verfügbar. Bitte erneut versuchen.');
  const usage = (await response.json()) as { usdMicros: number };
  if (creditExhausted(policy, usage.usdMicros)) {
    throw new Error(
      'Das Startguthaben ist aufgebraucht. Ihr Administrator kann die Testumgebung in den bezahlten Betrieb umstellen lassen. Ihre Chats und Dateien bleiben erhalten.',
    );
  }
}

/** SDK hooks must return a halt signal: thrown callback errors are non-fatal. */
export async function usageCreditHook(): Promise<{
  preventContinuation?: boolean;
  stopReason?: string;
  decision?: 'deny';
  reason?: string;
}> {
  try {
    await assertUsageCredit();
    return {};
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Die Guthabenprüfung ist momentan nicht verfügbar.';
    return { preventContinuation: true, stopReason: reason, decision: 'deny' as const, reason };
  }
}

export const usageCreditMiddleware: RequestHandler = async (req, res, next) => {
  const path = req.originalUrl.split('?')[0];
  if (/^\/api\/admin\/config(?:\/|$)/.test(path) && /^(POST|PUT|PATCH|DELETE)$/.test(req.method)) {
    try {
      const db = mongoose.connection.db;
      if (
        process.env.HOSTED_USAGE_REQUIRED === 'true' ||
        (await db?.collection<{ _id: string }>('eucowork_hosted').findOne({ _id: 'subscription' }))
      ) {
        const expected = process.env.JWT_SECRET
          ? crypto
              .createHmac('sha256', process.env.JWT_SECRET)
              .update('eucowork-hosted-config')
              .digest('hex')
          : '';
        const supplied = req.get('x-eucowork-config') ?? '';
        if (
          !expected ||
          supplied.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        ) {
          return void res.status(403).json({
            error:
              'Die Modell- und Abrechnungskonfiguration dieser gehosteten Umgebung wird durch Ihren Betreiber verwaltet.',
          });
        }
      }
    } catch {
      return void res
        .status(503)
        .json({ error: 'Die Konfigurationsprüfung ist momentan nicht verfügbar.' });
    }
  }
  const inference =
    req.method === 'POST' &&
    (/^\/api\/ask(?:\/|$)/.test(path) ||
      /^\/api\/agents\/chat(?:\/|$)/.test(path) ||
      /^\/api\/agents\/v1\/(?:responses|chat\/completions)(?:\/|$)/.test(path) ||
      /^\/api\/assistants\/(?:chat|v1\/threads)/.test(path));
  if (!inference || path.endsWith('/abort')) return next();
  try {
    await assertUsageCredit();
    next();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Die Guthabenprüfung ist momentan nicht verfügbar.';
    res.status(402).json({ error: message, message, code: 'USAGE_CREDIT_BLOCKED' });
  }
};
