import { Router, json } from 'express';
import { z } from 'zod';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ServerRequest } from '~/types';
import type { MailAssistantRuntime } from './runtime';
import { MailAuthorizationError } from './oauth';
import { MailAssistantError } from './engine';
import { defaultMailSettings } from './schedule';

const owner = (req: Request): string => {
  const request = req as ServerRequest;
  if (!request.user?.id || request.user.tenantId) throw new MailAuthorizationError();
  return String(request.user.id);
};
const safeRoute =
  (action: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, _next: NextFunction) => {
    void action(req, res).catch((error: Error) => {
      if (res.headersSent) return;
      const message =
        error instanceof MailAuthorizationError || error instanceof MailAssistantError
          ? error.message
          : 'Der Mail-Assistent konnte den Auftrag nicht abschliessen. Bitte den Status prüfen.';
      res.status(error instanceof MailAuthorizationError ? 403 : 400).json({ error: message });
    });
  };

export function createMailAssistantRouter(runtime: MailAssistantRuntime | null): Router {
  const router = Router();
  router.use(json({ limit: '8kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/status',
    safeRoute(async (req, res) => {
      if (!runtime) {
        res.json({
          available: false,
          reason: 'Der Mail-Assistent ist in dieser Umgebung noch nicht freigegeben.',
          modelLabel: '',
          connection: { connected: false },
          settings: defaultMailSettings(),
          activity: {
            running: false,
            pending: 0,
            hasMore: false,
            history: { mode: 'off', processed: 0, pending: 0, hasMore: false, completed: false },
          },
          results: [],
        });
        return;
      }
      res.json(await runtime.engine.status(owner(req)));
    }),
  );
  router.use((_req, res, next) => {
    if (!runtime) {
      res
        .status(503)
        .json({ error: 'Der Mail-Assistent ist in dieser Umgebung noch nicht freigegeben.' });
      return;
    }
    next();
  });
  router.put(
    '/settings',
    safeRoute(async (req, res) => {
      await runtime!.engine.settings(owner(req), req.body);
      res.json(await runtime!.engine.status(owner(req)));
    }),
  );
  router.post(
    '/connect',
    safeRoute(async (req, res) => {
      res.json({ authorizationUrl: await runtime!.oauth.start(owner(req)) });
    }),
  );
  router.post(
    '/run',
    safeRoute(async (req, res) => {
      const id = owner(req);
      const status = await runtime!.engine.status(id);
      if (!status.settings.enabled)
        throw new MailAssistantError('Bitte aktiviere zuerst deine persönliche Freigabe.');
      if (status.activity.running)
        throw new MailAssistantError('Dein Postfach wird bereits geprüft.');
      const [available, connection] = await Promise.all([
        runtime!.adapter.availability(id),
        runtime!.adapter.connection(id),
      ]);
      if (!available.available || !connection.connected)
        throw new MailAuthorizationError(
          'Bitte zuerst dein Postfach verbinden und die Freigabe des Standardmodells prüfen.',
        );
      void runtime!.engine.run(id).catch(() => undefined);
      res.status(202).json({ accepted: true });
    }),
  );
  router.post(
    '/pause',
    safeRoute(async (req, res) => {
      await runtime!.engine.pause(owner(req));
      res.json(await runtime!.engine.status(owner(req)));
    }),
  );
  router.delete(
    '/connection',
    safeRoute(async (req, res) => {
      const id = owner(req);
      await runtime!.engine.pause(id);
      await runtime!.oauth.disconnect(id);
      await runtime!.engine.disconnect(id);
      res.json(await runtime!.engine.status(id));
    }),
  );
  router.patch(
    '/results/:id/priority',
    safeRoute(async (req, res) => {
      const body = z
        .object({ priority: z.enum(['important', 'normal', 'low']) })
        .strict()
        .parse(req.body);
      const id = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(req.params.id);
      await runtime!.engine.priority(owner(req), id, body.priority);
      res.json(await runtime!.engine.status(owner(req)));
    }),
  );
  return router;
}

/** This sole unauthenticated callback can only consume a short-lived owner-bound PKCE state. */
export function createMailAssistantCallbackRouter(runtime: MailAssistantRuntime | null): Router {
  const router = Router();
  router.get('/mail-assistant/callback', async (req, res) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    let success = false;
    if (
      runtime &&
      typeof req.query.state === 'string' &&
      typeof req.query.code === 'string' &&
      !req.query.error
    ) {
      try {
        await runtime.oauth.complete(req.query.state, req.query.code);
        success = true;
      } catch {
        /* Provider details and codes must never enter rendered output or logs. */
      }
    }
    res
      .status(success ? 200 : 400)
      .type('html')
      .send(
        `<!doctype html><html lang="de"><meta charset="utf-8"><title>Persönlicher Mail-Assistent</title><h1>${success ? 'Postfach verbunden' : 'Postfach nicht verbunden'}</h1><p>${success ? 'Du kannst dieses Fenster schliessen und im Outlook-Add-in den Status aktualisieren. Die Verarbeitung beginnt erst nach deiner persönlichen Freigabe.' : 'Bitte schliesse dieses Fenster und verbinde dein eigenes Microsoft-Konto erneut. Das Konto muss zu deiner bestätigten Cowork-E-Mail-Adresse gehören.'}</p></html>`,
      );
  });
  return router;
}
