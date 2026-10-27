import { followupCommitSchema, followupPrepareSchema, followupSettingsSchema } from './followup';
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
  const status = async (id: string) => ({
    ...(await runtime!.engine.status(id)),
    odooAvailable: !!runtime?.followup,
  });
  router.use(json({ limit: '96kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/availability',
    safeRoute(async (req, res) => {
      const id = owner(req);
      if (!runtime) {
        res.json({ available: false, odooAvailable: false });
        return;
      }
      await runtime.adapter.authorize(id);
      res.json({ available: true, odooAvailable: !!runtime.followup });
    }),
  );
  router.get(
    '/status',
    safeRoute(async (req, res) => {
      if (!runtime) {
        res.json({
          available: false,
          odooAvailable: false,
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
      res.json(await status(owner(req)));
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
  router.get(
    '/inbox',
    safeRoute(async (req, res) => {
      if (!runtime!.inbox)
        throw new MailAssistantError('Die Posteingangsübersicht ist nicht verfügbar.');
      const query = z
        .object({ cursor: z.string().max(40000).optional() })
        .strict()
        .parse(req.query);
      res.json(await runtime!.inbox.inbox(owner(req), query.cursor));
    }),
  );
  router.get(
    '/results/:id/correspondence',
    safeRoute(async (req, res) => {
      if (!runtime!.inbox)
        throw new MailAssistantError('Die Korrespondenzsuche ist nicht verfügbar.');
      const query = z
        .object({
          cursor: z.string().max(40000).optional(),
          search: z.string().max(160).optional(),
        })
        .strict()
        .parse(req.query);
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.params.id);
      res.json(await runtime!.inbox.correspondence(owner(req), id, query));
    }),
  );
  router.post(
    '/results/:id/chat',
    safeRoute(async (req, res) => {
      if (!runtime!.chat) throw new MailAssistantError('Der Mail-Chat ist nicht verfügbar.');
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.params.id);
      res.json(await runtime!.chat(owner(req), id, req.body));
    }),
  );
  router.put(
    '/settings',
    safeRoute(async (req, res) => {
      await runtime!.engine.settings(owner(req), req.body);
      res.json(await status(owner(req)));
    }),
  );
  router.get(
    '/followup/settings',
    safeRoute(async (req, res) => {
      if (!runtime!.followup)
        throw new MailAssistantError('Die Aufgabenablage ist nicht verfügbar.');
      res.json(await runtime!.followup.settings(owner(req)));
    }),
  );
  router.put(
    '/followup/settings',
    safeRoute(async (req, res) => {
      if (!runtime!.followup)
        throw new MailAssistantError('Die Aufgabenablage ist nicht verfügbar.');
      res.json(
        await runtime!.followup.saveSettings(owner(req), followupSettingsSchema.parse(req.body)),
      );
    }),
  );
  router.get(
    '/followup/projects',
    safeRoute(async (req, res) => {
      if (!runtime!.followup)
        throw new MailAssistantError('Die Aufgabenablage ist nicht verfügbar.');
      const query = z
        .object({ profile: z.string().max(40), search: z.string().max(100).optional() })
        .strict()
        .parse(req.query);
      res.json({
        projects: await runtime!.followup.projects(owner(req), query.profile, query.search),
      });
    }),
  );
  router.post(
    '/results/:id/followup/prepare',
    safeRoute(async (req, res) => {
      if (!runtime!.followup)
        throw new MailAssistantError('Die Aufgabenablage ist nicht verfügbar.');
      res.json(
        await runtime!.followup.prepare(
          owner(req),
          z
            .string()
            .regex(/^[a-zA-Z0-9_-]{1,128}$/)
            .parse(req.params.id),
          followupPrepareSchema.parse(req.body),
        ),
      );
    }),
  );
  router.post(
    '/followup/commit',
    safeRoute(async (req, res) => {
      if (!runtime!.followup)
        throw new MailAssistantError('Die Aufgabenablage ist nicht verfügbar.');
      res.json(await runtime!.followup.commit(owner(req), followupCommitSchema.parse(req.body)));
    }),
  );
  router.get(
    '/move-jobs',
    safeRoute(async (req, res) => {
      res.json({ jobs: await runtime!.engine.moveJobs(owner(req)) });
    }),
  );
  router.post(
    '/move-jobs',
    safeRoute(async (req, res) => {
      res.status(202).json({ job: await runtime!.engine.enqueueMove(owner(req), req.body) });
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
      res.json(await status(owner(req)));
    }),
  );
  router.delete(
    '/connection',
    safeRoute(async (req, res) => {
      const id = owner(req);
      await runtime!.engine.pause(id);
      await runtime!.followup?.clearPreviews(id);
      await runtime!.oauth.disconnect(id);
      await runtime!.engine.disconnect(id);
      res.json(await status(id));
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
      res.json(await status(owner(req)));
    }),
  );
  router.get(
    '/results',
    safeRoute(async (req, res) => {
      const query = z
        .object({
          cursor: z.string().max(1024).optional(),
          search: z.string().max(200).optional(),
          priority: z.enum(['important', 'normal', 'low']).optional(),
          state: z.enum(['open', 'done', 'all']).optional(),
        })
        .strict()
        .parse(req.query);
      res.json(await runtime!.engine.results(owner(req), query));
    }),
  );
  router.get(
    '/folders',
    safeRoute(async (req, res) => {
      const query = z
        .object({ parentId: z.string().min(1).max(2048).optional() })
        .strict()
        .parse(req.query);
      res.json({ folders: await runtime!.engine.folders(owner(req), query.parentId) });
    }),
  );
  router.post(
    '/results/:id/move',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const body = z
        .object({
          folderId: z.string().min(1).max(2048),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      res.json({
        result: await runtime!.engine.move(owner(req), id, body.folderId, body.revision),
      });
    }),
  );
  router.put(
    '/results/:id/draft',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const body = z
        .object({
          body: z.string().min(1).max(12000),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      await runtime!.engine.editDraft(owner(req), id, body.body, body.revision);
      res.status(204).end();
    }),
  );
  router.post(
    '/results/:id/draft-request',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const body = z
        .object({
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          instructions: z.string().max(4000).default(''),
          requestId: z.string().uuid(),
        })
        .strict()
        .parse(req.body);
      res.json(await runtime!.engine.requestDraft(owner(req), id, body));
    }),
  );
  router.get(
    '/results/:id/attachments',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      res.json(await runtime!.engine.attachments(owner(req), id));
    }),
  );
  router.get(
    '/results/:id/content',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(req.params.id);
      res.json(await runtime!.engine.content(owner(req), id));
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
        `<!doctype html><html lang="de"><meta charset="utf-8"><title>Persönlicher Mail-Assistent</title><h1>${success ? 'Postfach verbunden' : 'Postfach nicht verbunden'}</h1><p>${success ? 'Du kannst dieses Fenster schliessen und in Cowork oder im Outlook-Add-in den Status aktualisieren. Die Verarbeitung beginnt erst nach deiner persönlichen Freigabe.' : 'Bitte schliesse dieses Fenster und verbinde dein eigenes Microsoft-Konto erneut. Das Konto muss zu deiner bestätigten Cowork-E-Mail-Adresse gehören.'}</p></html>`,
      );
  });
  return router;
}
