import { Router, json, urlencoded } from 'express';
import { z } from 'zod';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import type { OpsAuthorization } from './types';
import type { ServerRequest } from '~/types';
import {
  OpsPersonalError,
  OpsPersonalService,
  parseOpsAuthorization,
  requireOpsPersonalEnabled,
  OPS_PERSONAL_REDIRECT,
  OPS_PERSONAL_ISSUER,
  requestedOpsScopes,
} from './service';

const scope = z.enum(['mail:compose', 'skills:use', 'brain:read', 'mail:background']);
const authorization = z
  .object({
    response_type: z.literal('code'),
    client_id: z.literal('ops'),
    redirect_uri: z.literal(OPS_PERSONAL_REDIRECT),
    state: z.string(),
    code_challenge: z.string(),
    code_challenge_method: z.literal('S256'),
    ops_user_id: z.string(),
    scope: z.string().max(128).optional(),
  })
  .strict();
const exchange = z.discriminatedUnion('grant_type', [
  z
    .object({
      client_id: z.literal('ops'),
      grant_type: z.literal('authorization_code'),
      code: z.string().max(128),
      code_verifier: z.string().max(128),
      redirect_uri: z.literal(OPS_PERSONAL_REDIRECT),
      ops_user_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      client_id: z.literal('ops'),
      grant_type: z.literal('refresh_token'),
      refresh_token: z.string().max(128),
      ops_user_id: z.string().uuid(),
    })
    .strict(),
]);
const consent = z.object({ authorization, scopes: z.array(scope).max(4) }).strict();
const revocation = z
  .object({
    client_id: z.literal('ops'),
    token: z.string().max(128),
    ops_user_id: z.string().uuid(),
    token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  })
  .strict();
const denyBrowser: RequestHandler = (req, _res, next) =>
  next(req.headers.origin ? new OpsPersonalError(403, 'browser_forbidden') : undefined);

export function createOpsPersonalRouter(
  service: OpsPersonalService,
  session: RequestHandler,
): Router {
  const router = Router();
  const attempts = new Map<string, { until: number; count: number }>();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'no-referrer');
    try {
      requireOpsPersonalEnabled();
      if (req.headers['x-tenant-id']) throw new OpsPersonalError(403, 'tenant_not_allowed');
      next();
    } catch (error) {
      next(error);
    }
  });
  router.use(json({ limit: '16kb', inflate: false }));
  router.use(urlencoded({ extended: false, limit: '16kb', inflate: false, parameterLimit: 20 }));
  const limited: RequestHandler = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip ?? 'unknown';
    const current = attempts.get(key) ?? { until: now + 60_000, count: 0 };
    if (attempts.size >= 5000 || ++current.count > 60) {
      res.set('Retry-After', '60');
      return next(new OpsPersonalError(429, 'rate_limited'));
    }
    attempts.set(key, current);
    next();
  };
  const run =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      void handler(req, res).catch(next);
    };
  const sameOrigin: RequestHandler = (req, _res, next) => {
    try {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new Error();
      if (req.headers.origin) {
        if (req.headers.origin !== OPS_PERSONAL_ISSUER) throw new Error();
      }
      next();
    } catch {
      next(new OpsPersonalError(403, 'browser_forbidden'));
    }
  };
  const owner = (req: Request) => {
    const user = (req as ServerRequest).user;
    if (!user?.id || !req.headers.authorization?.startsWith('Bearer '))
      throw new OpsPersonalError(401, 'unauthenticated');
    return String(user.id);
  };
  router.post(
    '/token',
    denyBrowser,
    limited,
    run(async (req, res) => {
      const input = exchange.parse(req.body);
      const result =
        input.grant_type === 'authorization_code'
          ? await service.exchange(
              input.code,
              input.code_verifier,
              input.redirect_uri,
              input.ops_user_id,
            )
          : await service.refresh(input.refresh_token, input.ops_user_id);
      res.json(result);
    }),
  );
  router.post(
    '/revoke',
    denyBrowser,
    limited,
    run(async (req, res) => {
      const input = revocation.parse(req.body);
      await service.revoke(input.token, input.ops_user_id);
      res.json({ revoked: true });
    }),
  );
  router.get(
    '/connection',
    denyBrowser,
    limited,
    run(async (req, res) => {
      const { value, opsUserId } = service.credentials(req);
      const { grant } = await service.access(value, opsUserId);
      res.json({
        issuer: OPS_PERSONAL_ISSUER,
        tenant_id: 'cwv01',
        subject: grant.ownerId,
        ops_user_id: grant.opsUserId,
        grant_id: grant._id,
        scope: grant.scopes.join(' '),
        expires_at: grant.expiresAt.toISOString(),
      });
    }),
  );
  router.get(
    '/skills',
    denyBrowser,
    limited,
    run(async (req, res) => {
      res.json(await service.skills(req));
    }),
  );
  router.get(
    '/authorize',
    sameOrigin,
    session,
    run(async (req, res) => {
      const input = parseOpsAuthorization(authorization.parse(req.query) as OpsAuthorization);
      const user = await service.user(owner(req));
      res.json({
        authorization: input,
        account: user.name ?? user.username ?? user.email,
        client_name: 'OPS Manager',
        scopes: ['mail:compose', 'skills:use'],
        optional_scopes: requestedOpsScopes(input.scope).filter(
          (scope) => scope === 'brain:read' || scope === 'mail:background',
        ),
      });
    }),
  );
  router.post(
    '/authorize',
    sameOrigin,
    session,
    limited,
    run(async (req, res) => {
      const input = consent.parse(req.body);
      res.json(
        await service.authorize(owner(req), input.authorization as OpsAuthorization, input.scopes),
      );
    }),
  );
  router.get(
    '/grants',
    session,
    run(async (req, res) => {
      const user = await service.user(owner(req));
      const grants = await service.store.list(user.id, new Date(service.now()));
      res.json({
        grants: grants.map((grant) => ({
          id: grant._id,
          scopes: grant.scopes,
          created_at: grant.createdAt.toISOString(),
          expires_at: grant.expiresAt.toISOString(),
        })),
      });
    }),
  );
  router.delete(
    '/grants/:id',
    sameOrigin,
    session,
    run(async (req, res) => {
      const id = req.params.id;
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
        throw new OpsPersonalError(400, 'invalid_request');
      await service.user(owner(req));
      await service.store.revoke(id, new Date(service.now()), owner(req));
      res.json({ revoked: true });
    }),
  );
  router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const known = error instanceof OpsPersonalError;
    const bodyError = 'type' in error ? error.type : undefined;
    let status = 503;
    let code = 'temporarily_unavailable';
    if (known) {
      status = error.status;
      code = error.code;
    } else if (bodyError === 'encoding.unsupported') {
      status = 415;
      code = 'unsupported_encoding';
    } else if (bodyError === 'entity.too.large') {
      status = 413;
      code = 'request_too_large';
    } else if (error instanceof z.ZodError || bodyError === 'entity.parse.failed') {
      status = 400;
      code = 'invalid_request';
    }
    if (req.path === '/token' && (code === 'invalid_grant' || code === 'inactive_user')) {
      status = 400;
      code = 'invalid_grant';
    }
    if ((req.path === '/connection' || req.path === '/skills') && status === 401)
      code = 'invalid_token';
    if (status === 401) res.set('WWW-Authenticate', 'Bearer');
    res.status(status).json({
      error: code,
      error_description: 'Die persönliche OPS-Verbindung konnte nicht sicher verarbeitet werden.',
    });
  });
  return router;
}

/** A fixed public client uses S256 PKCE; OPS user IDs bind grants but do not authenticate a caller. */
export function createOpsPersonalDiscoveryRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      requireOpsPersonalEnabled();
    } catch {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      issuer: OPS_PERSONAL_ISSUER,
      authorization_endpoint: `${OPS_PERSONAL_ISSUER}/ops-connect`,
      token_endpoint: `${OPS_PERSONAL_ISSUER}/api/ops-personal/token`,
      revocation_endpoint: `${OPS_PERSONAL_ISSUER}/api/ops-personal/revoke`,
      scopes_supported: ['mail:compose', 'skills:use', 'brain:read', 'mail:background'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      ops_connection_endpoint: `${OPS_PERSONAL_ISSUER}/api/ops-personal/connection`,
      ops_user_id_required: true,
    });
  });
  return router;
}
