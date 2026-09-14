import { Router } from 'express';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import { generateCheckAccess } from '~/middleware/access';
import { BrainServiceError, isBrainConfigured, requestBrain } from './client';
import type { ServerRequest } from '~/types';
import type { BrainHistoryService } from './history';
import type { BrainRebuildStatus } from 'librechat-data-provider';
import { BrainHistoryError } from './history';
import type { BrainFailureReporter } from './diagnostics';
import { classifyBrainFailure, createBrainFailureReporter } from './diagnostics';

const queryKeys = new Set(['query', 'scope', 'cursor', 'limit', 'conversationId']);

export function getBrainProxyPath(req: Pick<Request, 'path' | 'query'>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (queryKeys.has(key) && typeof value === 'string') {
      query.set(key, value);
    }
  }
  const suffix = query.toString();
  return `/v1${req.path}${suffix ? `?${suffix}` : ''}`;
}

export function createBrainRouter({
  getRoleByName,
  history,
  reportFailure = createBrainFailureReporter(),
}: {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  history?: BrainHistoryService;
  reportFailure?: BrainFailureReporter;
}): Router {
  const router = Router();
  const access = (permission: Permissions): RequestHandler => {
    const check = generateCheckAccess({
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE, permission],
      getRoleByName,
    });
    return async (req, res, next) => {
      await check(req, res, next);
    };
  };
  const proxy: RequestHandler = async (req, res) => {
    const user = req.user as IUser | undefined;
    if (!user?.id) {
      res.status(401).json({ error: 'Bitte melde dich erneut an.' });
      return;
    }
    try {
      const result = await requestBrain<object>(
        String(user.id),
        req.method,
        getBrainProxyPath(req),
        ['POST', 'PATCH'].includes(req.method) ? req.body : undefined,
        req.method === 'POST' && req.path.startsWith('/rebuild') ? 120_000 : 5_000,
      );
      res.status(req.method === 'POST' ? 201 : 200).json(result);
    } catch (error) {
      const failure = error instanceof BrainServiceError ? error : new BrainServiceError(503);
      const diagnostic = classifyBrainFailure(error, 'request');
      if (failure.status >= 500)
        await reportFailure({
          failure: diagnostic,
          userId: String(user.id),
          operation: 'request',
          stage: 'request',
        });
      res.status(failure.status).json({
        error: failure.message,
        ...(failure.status >= 500
          ? { incidentId: diagnostic.incidentId, errorCode: diagnostic.code }
          : {}),
      });
    }
  };
  router.get('/status', access(Permissions.READ), (_req, res) => {
    res.json({ enabled: isBrainConfigured() });
  });
  if (history) {
    const historyHandler =
      (operation: 'status' | 'start' | 'pause'): RequestHandler =>
      async (req, res) => {
        if (!(req.user as IUser | undefined)?.id) {
          res.status(401).json({ error: 'Bitte melde dich erneut an.' });
          return;
        }
        try {
          res.json(await history[operation](req as ServerRequest));
        } catch (error) {
          const failure = classifyBrainFailure(error, 'start');
          await reportFailure({
            failure,
            userId: String((req.user as IUser).id),
            operation: 'history',
            stage: 'start',
          });
          res.status(503).json({
            error: error instanceof BrainHistoryError ? error.message : failure.message,
            incidentId: failure.incidentId,
            errorCode: failure.code,
          });
        }
      };
    router.get('/history', historyHandler('status'));
    router.post('/history', historyHandler('start'));
    router.post('/history/pause', historyHandler('pause'));
    router.post(
      '/rebuild',
      access(Permissions.CREATE),
      access(Permissions.UPDATE),
      async (req, res) => {
        const request = req as ServerRequest;
        const userId = String(request.user!.id);
        try {
          const available = await history.status(request);
          if (!available.available) {
            res
              .status(409)
              .json({ error: available.reason ?? 'Der Neuaufbau ist zurzeit nicht verfügbar.' });
            return;
          }
          const result = await requestBrain<BrainRebuildStatus>(userId, 'POST', '/v1/rebuild', {});
          if (!result.rebuild)
            throw new BrainHistoryError('Der Neuaufbau konnte nicht vorbereitet werden.');
          if (result.rebuild.status === 'building')
            await history.start(request, { rebuildId: result.rebuild.id });
          res.status(201).json(result);
        } catch (error) {
          const failure = classifyBrainFailure(error, 'start');
          await reportFailure({ failure, userId, operation: 'history', stage: 'start' });
          res.status(error instanceof BrainServiceError ? error.status : 503).json({
            error:
              error instanceof BrainServiceError || error instanceof BrainHistoryError
                ? error.message
                : failure.message,
            incidentId: failure.incidentId,
            errorCode: failure.code,
          });
        }
      },
    );
    router.get('/rebuild', access(Permissions.READ), proxy);
    const reportRebuildFailure = async (req: Request, res: Response, error: unknown) => {
      const failure = classifyBrainFailure(error, 'request');
      await reportFailure({
        failure,
        userId: String((req.user as IUser).id),
        operation: 'history',
        stage: 'request',
      }).catch(() => undefined);
      res.status(error instanceof BrainServiceError ? error.status : 503).json({
        error:
          error instanceof BrainHistoryError || error instanceof BrainServiceError
            ? error.message
            : failure.message,
        incidentId: failure.incidentId,
        errorCode: failure.code,
      });
    };
    const rebuildWrite: RequestHandler = async (req, res, next) => {
      try {
        const availability = await history.status(req as ServerRequest);
        if (!availability.available) {
          res
            .status(409)
            .json({ error: availability.reason ?? 'Brain ist für dein Konto ausgeschaltet.' });
          return;
        }
        next();
      } catch (error) {
        await reportRebuildFailure(req, res, error);
      }
    };
    router.post(
      '/rebuild/:id/activate',
      access(Permissions.CREATE),
      access(Permissions.UPDATE),
      rebuildWrite,
      proxy,
    );
    router.post(
      '/rebuild/:id/discard',
      access(Permissions.UPDATE),
      async (req, res, next) => {
        try {
          await history.pause(req as ServerRequest, String(req.params.id));
          next();
        } catch (error) {
          await reportRebuildFailure(req, res, error);
        }
      },
      proxy,
    );
    router.post(
      '/rebuild/rollback',
      access(Permissions.READ),
      access(Permissions.CREATE),
      access(Permissions.UPDATE),
      rebuildWrite,
      proxy,
    );
  }
  router.get('/graph', access(Permissions.READ), proxy);
  router.get('/export', access(Permissions.READ), proxy);
  router.get('/recalls', access(Permissions.READ), proxy);
  router.get('/nodes/:id', access(Permissions.READ), proxy);
  router.post('/nodes', access(Permissions.CREATE), proxy);
  router.patch('/nodes/:id', access(Permissions.UPDATE), proxy);
  router.delete('/nodes/:id', access(Permissions.UPDATE), proxy);
  return router;
}
