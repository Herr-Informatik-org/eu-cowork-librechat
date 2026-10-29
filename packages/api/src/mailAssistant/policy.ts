import { Router, json } from 'express';
import { randomUUID } from 'node:crypto';
import { normalizeMailTrustedOrigins } from 'librechat-data-provider';
import type { Collection } from 'mongodb';
import type { Request } from 'express';
import type { RecordAuditEntryInput, RecordAuditEntryOptions } from '@librechat/data-schemas';

export const MAIL_SECURITY_COLLECTION = 'eucowork_mail_security';
const policyKey = 'instance';

export interface MailSecurityPolicy {
  _id: string;
  revision: string;
  trustedOrigins: string[];
  updatedAt?: string;
}

export interface MailSecurityPolicyStore {
  read(): Promise<MailSecurityPolicy>;
  write(revision: string, trustedOrigins: string[]): Promise<MailSecurityPolicy>;
}

export function createMailSecurityPolicy(
  collection: () => Collection<MailSecurityPolicy>,
  env: NodeJS.ProcessEnv = process.env,
): MailSecurityPolicyStore {
  const defaults =
    env.MAIL_ASSISTANT_INSTANCE === 'cw01' && env.MAIL_ASSISTANT_ERP_LINKS_ENABLED === 'true'
      ? ['https://erp.rzcloud.ch']
      : [];
  async function read(): Promise<MailSecurityPolicy> {
    const stored = await collection().findOne({ _id: policyKey });
    if (!stored) return { _id: policyKey, revision: 'initial', trustedOrigins: [...defaults] };
    const origins = normalizeMailTrustedOrigins(stored.trustedOrigins);
    if (!origins)
      throw new Error('Die Linkfreigaben sind ungültig. Bitte den Administrator informieren.');
    return {
      _id: policyKey,
      revision: stored.revision,
      trustedOrigins: origins,
      ...(stored.updatedAt && { updatedAt: stored.updatedAt }),
    };
  }
  async function write(revision: string, trustedOrigins: string[]): Promise<MailSecurityPolicy> {
    const origins = normalizeMailTrustedOrigins(trustedOrigins);
    if (!origins)
      throw new Error(
        'Bitte nur vollständige HTTPS-Adressen ohne Pfad, Port oder Platzhalter eintragen.',
      );
    const next: MailSecurityPolicy = {
      _id: policyKey,
      revision: randomUUID(),
      trustedOrigins: origins,
      updatedAt: new Date().toISOString(),
    };
    if (revision === 'initial') {
      await collection().insertOne(next);
      return next;
    }
    const result = await collection().replaceOne({ _id: policyKey, revision }, next);
    if (result.modifiedCount !== 1)
      throw new Error('Die Freigaben wurden inzwischen verändert. Bitte neu laden.');
    return next;
  }
  return { read, write };
}

interface MailSecurityAdminDependencies {
  collection: () => Collection<MailSecurityPolicy>;
  authorize(req: Request): Promise<{ id: string } | null>;
  audit(input: RecordAuditEntryInput, options: RecordAuditEntryOptions): Promise<object | null>;
  env?: NodeJS.ProcessEnv;
}

/** The surrounding native admin router also requires JWT and ACCESS_ADMIN. */
export function createMailSecurityAdminRouter(deps: MailSecurityAdminDependencies): Router {
  const router = Router();
  const policy = createMailSecurityPolicy(deps.collection, deps.env);
  router.use(json({ limit: '16kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (req, res) => {
    void (async () => {
      if (!(await deps.authorize(req))) {
        res.sendStatus(403);
        return;
      }
      res.json(await policy.read());
    })().catch(() =>
      res.status(503).json({ error: 'Die Mail-Linkfreigaben sind derzeit nicht verfügbar.' }),
    );
  });
  router.put('/', (req, res) => {
    void (async () => {
      const actor = await deps.authorize(req);
      if (!actor) {
        res.sendStatus(403);
        return;
      }
      const input = req.body as { revision?: string; trustedOrigins?: string[] };
      if (
        !input ||
        Object.keys(input).some((key) => !['revision', 'trustedOrigins'].includes(key)) ||
        typeof input.revision !== 'string' ||
        !/^(initial|[a-f0-9-]{36})$/.test(input.revision) ||
        !Array.isArray(input.trustedOrigins) ||
        !normalizeMailTrustedOrigins(input.trustedOrigins)
      ) {
        res.status(400).json({
          error: 'Ungültige Linkfreigaben. Erlaubt sind höchstens 32 genaue HTTPS-Adressen.',
        });
        return;
      }
      const entry = await deps.audit(
        {
          action: 'mail_assistant.operation',
          actor: { type: 'user', id: actor.id, name: actor.id },
          target: { type: 'mail_security_policy', id: policyKey },
          metadata: {
            event: 'trusted_origins_update_requested',
            revision: input.revision,
            origins: input.trustedOrigins.join(','),
          },
        },
        { failClosed: true },
      );
      if (!entry) throw new Error('Audit unavailable');
      res.json(await policy.write(input.revision, input.trustedOrigins));
    })().catch(() =>
      res.status(409).json({
        error:
          'Die Freigaben konnten nicht gespeichert werden. Bitte neu laden und erneut versuchen.',
      }),
    );
  });
  return router;
}
