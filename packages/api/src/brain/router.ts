import { Router } from 'express';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';
import { generateCheckAccess } from '~/middleware/access';
import { BrainServiceError, isBrainConfigured, requestBrain } from './client';
import type { ServerRequest } from '~/types';
import type { BrainHistoryService } from './history';
import { BrainHistoryError } from './history';

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
}: {
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[]) => Promise<IRole | null>;
  history?: BrainHistoryService;
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
      );
      res.status(req.method === 'POST' ? 201 : 200).json(result);
    } catch (error) {
      const failure = error instanceof BrainServiceError ? error : new BrainServiceError(503);
      res.status(failure.status).json({ error: failure.message });
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
          res
            .status(503)
            .json({
              error:
                error instanceof BrainHistoryError
                  ? error.message
                  : 'Die Chat-Verarbeitung ist zurzeit nicht verfügbar.',
            });
        }
      };
    router.get('/history', historyHandler('status'));
    router.post('/history', historyHandler('start'));
    router.post('/history/pause', historyHandler('pause'));
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
