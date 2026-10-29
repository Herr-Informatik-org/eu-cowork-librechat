import { followupCommitSchema, followupPrepareSchema, followupSettingsSchema } from './followup';
import { Router, json } from 'express';
import { z } from 'zod';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ServerRequest } from '~/types';
import type { MailAssistantRuntime } from './runtime';
import { MailAuthorizationError } from './oauth';
import { MailAssistantError } from './engine';
import { defaultMailSettings } from './schedule';
import { MailDraftError } from './errors';

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
        error instanceof MailAuthorizationError ||
        error instanceof MailAssistantError ||
        error instanceof MailDraftError
          ? error.message
          : 'Der Mail-Assistent konnte den Auftrag nicht abschliessen. Bitte den Status prüfen.';
      let status = 400;
      if (error instanceof MailAuthorizationError) status = 403;
      else if (error instanceof MailDraftError) status = error.status;
      res.status(status).json({ error: message });
    });
  };

export function createMailAssistantRouter(runtime: MailAssistantRuntime | null): Router {
  const router = Router();
  let activeDownloads = 0;
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
    '/results/:id/rule',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const input = z
        .object({
          text: z.string().trim().min(12).max(2400),
          scope: z.enum(['sender', 'global']),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      await runtime!.engine.rememberRule(owner(req), id, input);
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
          newReply: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      res.json(await runtime!.engine.requestDraft(owner(req), id, body));
    }),
  );
  router.post(
    '/results/:id/images',
    safeRoute(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const body = z
        .object({
          kind: z.enum(['original', 'draft']),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      res.json(await runtime!.engine.images(owner(req), id, body.kind, body.revision));
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
  router.post(
    '/results/:id/attachments/:attachmentId/download',
    safeRoute(async (req, res) => {
      const requester = owner(req);
      const id = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(req.params.id);
      const attachmentId = z.string().min(1).max(2048).parse(req.params.attachmentId);
      const { revision } = z
        .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      if (!runtime!.engine.downloadAttachment)
        throw new MailAssistantError('Die geprüfte Anhangfreigabe ist nicht verfügbar.');
      if (activeDownloads >= 2)
        throw new MailDraftError(
          'Es laufen bereits Anhangprüfungen. Bitte versuche es später erneut.',
          429,
        );
      activeDownloads += 1;
      let released = false;
      let workFinished = false;
      let responseFinished = false;
      const release = () => {
        if (!released && workFinished && responseFinished) {
          activeDownloads -= 1;
          released = true;
        }
      };
      const responseDone = () => {
        responseFinished = true;
        release();
      };
      res.once('finish', responseDone);
      res.once('close', responseDone);
      res.setTimeout(90_000, () => res.destroy());
      try {
        const file = await runtime!.engine.downloadAttachment(
          requester,
          id,
          attachmentId,
          revision,
        );
        if (req.aborted || res.destroyed) return;
        res.attachment(file.name);
        res.set({
          'Content-Type': 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'no-store',
          'X-Mail-Attachment-Scan': file.scan.verdict,
          'X-Mail-Attachment-Scanned-At': file.scan.scannedAt,
        });
        res.send(file.bytes);
      } finally {
        // A disconnected browser cannot free capacity while its scan is still running.
        workFinished = true;
        release();
      }
    }),
  );
  const research = () => {
    if (!runtime?.research)
      throw new MailAssistantError(
        'Die manuelle Mail-Recherche ist in dieser Umgebung nicht aktiviert.',
      );
    return runtime.research;
  };
  router.get(
    '/research/settings',
    safeRoute(async (req, res) => {
      const id = owner(req);
      if (!runtime?.research) {
        res.json({
          available: false,
          reason: 'Die manuelle Mail-Recherche ist nicht aktiviert.',
          profiles: [],
          skills: [],
        });
        return;
      }
      res.json(await research().settings(id));
    }),
  );
  router.put(
    '/research/skills/:id',
    safeRoute(async (req, res) => {
      res.json(await research().saveSkill(owner(req), req.params.id, req.body));
    }),
  );
  router.get(
    '/research/customers',
    safeRoute(async (req, res) => {
      const query = z
        .object({ profileId: z.string(), search: z.string() })
        .strict()
        .parse(req.query);
      res.json(await research().customers(owner(req), query.profileId, query.search));
    }),
  );
  router.post(
    '/results/:id/research',
    safeRoute(async (req, res) => {
      res.status(202).json(await research().enqueue(owner(req), req.params.id, req.body));
    }),
  );
  router.get(
    '/research/jobs',
    safeRoute(async (req, res) => {
      res.json(await research().jobs(owner(req)));
    }),
  );
  router.get(
    '/research/jobs/:id',
    safeRoute(async (req, res) => {
      res.json(await research().job(owner(req), req.params.id));
    }),
  );
  router.post(
    '/research/jobs/:id/cancel',
    safeRoute(async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.json(await research().cancel(owner(req), req.params.id));
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
