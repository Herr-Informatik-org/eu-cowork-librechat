import { z } from 'zod';
import { Router } from 'express';
import { isAgentsEndpoint, EModelEndpoint, tModelSpecSchema } from 'librechat-data-provider';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ConversationMethods, MessageMethods, IMongoFile } from '@librechat/data-schemas';
import type { TModelSpec } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { excludeHiddenModelSpecs, sanitizeModelSpecs } from '~/modelSpecs';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
const chatRequestSchema = z
  .object({
    spec: z.string().min(1).max(200),
    text: z.string().min(1).max(250_000),
    messageId: identifier,
    parentMessageId: identifier.nullable().optional(),
    conversationId: identifier.optional(),
    clientRequestId: identifier,
    files: z
      .array(z.object({ file_id: identifier }).strict())
      .max(10)
      .optional(),
  })
  .strict();
const uploadMetadataSchema = z
  .object({
    spec: z.string().min(1).max(200),
    file_id: z.string().uuid(),
    width: z.coerce.number().int().min(1).max(32768),
    height: z.coerce.number().int().min(1).max(32768),
  })
  .strict();

export interface OfficeDependencies {
  authenticate: RequestHandler[];
  configure: RequestHandler;
  chatRouter: Router;
  imageUpload: RequestHandler[];
  imageRouter: Router;
  cleanupUpload: (req: Request) => Promise<void>;
  remoteAgentIds: (req: ServerRequest) => Promise<Set<string>>;
  getFiles: (filter: { user: string; file_id: { $in: string[] } }) => Promise<IMongoFile[] | null>;
  getConvo: ConversationMethods['getConvo'];
  getConvosByCursor: ConversationMethods['getConvosByCursor'];
  getMessages: MessageMethods['getMessages'];
}

function visibleSpecs(req: ServerRequest): TModelSpec[] {
  const parsed = z.array(tModelSpecSchema).safeParse(req.config?.modelSpecs?.list ?? []);
  if (!parsed.success) return [];
  return excludeHiddenModelSpecs({ list: parsed.data }).list;
}

async function availableSpecs(req: ServerRequest, deps: OfficeDependencies): Promise<TModelSpec[]> {
  const specs = visibleSpecs(req);
  const agentIds = specs.some((spec) => isAgentsEndpoint(spec.preset?.endpoint))
    ? await deps.remoteAgentIds(req)
    : new Set<string>();
  return specs.filter((spec) => {
    const preset = spec.preset;
    if (!preset?.endpoint) return false;
    if (isAgentsEndpoint(preset.endpoint)) {
      return typeof preset.agent_id === 'string' && agentIds.has(preset.agent_id);
    }
    return typeof preset.model === 'string' && preset.model.length > 0;
  });
}

function nativeSelection(spec: TModelSpec) {
  const endpoint = spec.preset.endpoint;
  const known = Object.values(EModelEndpoint).includes(endpoint as EModelEndpoint);
  return {
    ...spec.preset,
    spec: spec.name,
    endpoint,
    ...(!known ? { endpointType: EModelEndpoint.custom } : {}),
  };
}

function isNativeChatRoute(req: Request): boolean {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (req.method === 'POST') return path === '/chat/abort';
  return (
    req.method === 'GET' &&
    (path === '/chat/active' || /^\/chat\/(stream|status)\/[A-Za-z0-9:_-]{1,128}$/.test(path))
  );
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** The Office transport reuses native chat persistence, accounting and stream ownership. */
export function createOfficeRouter(deps: OfficeDependencies): Router {
  const router = Router();
  router.use(...deps.authenticate);
  router.use((req, res, next) => {
    const request = req as ServerRequest & { tenantId?: string };
    if (!request.user?.id) {
      res.status(401).json({ error: 'Bitte melde dich erneut an.' });
      return;
    }
    if (request.tenantId && request.user.tenantId && request.tenantId !== request.user.tenantId) {
      res.status(403).json({ error: 'Die Anmeldung gehört zu einer anderen Umgebung.' });
      return;
    }
    next();
  });
  router.use(deps.configure);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/models',
    asyncRoute(async (req, res) => {
      const specs = await availableSpecs(req as ServerRequest, deps);
      const safe = sanitizeModelSpecs({ list: specs })?.list ?? [];
      res.json({ data: safe.map((spec) => ({ ...spec, id: spec.name })) });
    }),
  );

  router.get(
    '/conversations',
    asyncRoute(async (req, res) => {
      const user = (req as ServerRequest).user!;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 30));
      res.json(await deps.getConvosByCursor(user.id, { cursor, limit, isArchived: false }));
    }),
  );

  router.get(
    '/conversations/:conversationId',
    asyncRoute(async (req, res) => {
      const parsed = identifier.safeParse(req.params.conversationId);
      if (!parsed.success) {
        res.status(400).json({ error: 'Ungültige Gesprächskennung.' });
        return;
      }
      const user = (req as ServerRequest).user!;
      const conversation = await deps.getConvo(user.id, parsed.data);
      if (!conversation) {
        res.status(404).json({ error: 'Gespräch nicht gefunden.' });
        return;
      }
      const messages = await deps.getMessages({ user: user.id, conversationId: parsed.data });
      res.json({ conversation, messages });
    }),
  );

  const imageRouter = Router();
  imageRouter.post(
    '/',
    ...deps.imageUpload,
    asyncRoute(async (req, res, next) => {
      const request = req as ServerRequest;
      const parsed = uploadMetadataSchema.safeParse(req.body);
      if (!parsed.success) {
        await deps.cleanupUpload(req);
        res.status(400).json({ error: 'Ungültige Angaben zum Bild-Upload.' });
        return;
      }
      let specs: TModelSpec[];
      try {
        specs = await availableSpecs(request, deps);
      } catch (error) {
        await deps.cleanupUpload(req);
        next(error);
        return;
      }
      const spec = specs.find((item) => item.name === parsed.data.spec);
      if (!spec) {
        await deps.cleanupUpload(req);
        res.status(403).json({ error: 'Dieses Modell steht nicht zur Verfügung.' });
        return;
      }
      const selection = nativeSelection(spec);
      req.body = {
        endpoint: selection.endpoint,
        ...(selection.endpointType && { endpointType: selection.endpointType }),
        file_id: parsed.data.file_id,
        width: parsed.data.width,
        height: parsed.data.height,
        context: 'message_attachment',
      };
      deps.imageRouter(req, res, next);
    }),
  );
  router.use('/files/images', imageRouter);

  router.post(
    '/chat',
    asyncRoute(async (req, res, next) => {
      const request = req as ServerRequest;
      const parsed = chatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Ungültiger Outlook-Chat-Auftrag.' });
        return;
      }
      const input = parsed.data;
      const spec = (await availableSpecs(request, deps)).find((item) => item.name === input.spec);
      if (!spec) {
        res.status(403).json({ error: 'Dieses Modell steht nicht zur Verfügung.' });
        return;
      }
      const user = request.user!;
      if (input.conversationId && input.conversationId !== 'new') {
        const conversation = await deps.getConvo(user.id, input.conversationId);
        if (!conversation) {
          res.status(404).json({ error: 'Gespräch nicht gefunden.' });
          return;
        }
        if (input.parentMessageId) {
          const parent = await deps.getMessages({
            user: user.id,
            conversationId: input.conversationId,
            messageId: input.parentMessageId,
          });
          if (!parent.length) {
            res
              .status(400)
              .json({ error: 'Die vorherige Nachricht gehört nicht zu diesem Gespräch.' });
            return;
          }
        }
      } else if (input.parentMessageId) {
        res.status(400).json({ error: 'Ein neues Gespräch hat keine vorherige Nachricht.' });
        return;
      }
      const fileIds = [...new Set(input.files?.map((file) => file.file_id) ?? [])];
      const files = fileIds.length
        ? ((await deps.getFiles({ user: user.id, file_id: { $in: fileIds } })) ?? [])
        : [];
      if (
        files.length !== fileIds.length ||
        files.some(
          (file) =>
            !file.type?.startsWith('image/') ||
            (file.expiresAt != null && new Date(file.expiresAt).getTime() <= Date.now()) ||
            (file.expiredAt != null && new Date(file.expiredAt).getTime() <= Date.now()),
        )
      ) {
        res.status(404).json({ error: 'Mindestens ein Bild ist nicht verfügbar.' });
        return;
      }
      req.body = {
        ...nativeSelection(spec),
        text: input.text,
        messageId: input.messageId,
        parentMessageId: input.parentMessageId ?? null,
        conversationId: input.conversationId ?? 'new',
        clientRequestId: input.clientRequestId,
        files,
      };
      deps.chatRouter(req, res, next);
    }),
  );

  router.use((req, res, next) => {
    if (!isNativeChatRoute(req)) {
      res.status(404).json({ error: 'Nicht gefunden.' });
      return;
    }
    deps.chatRouter(req, res, next);
  });
  return router;
}
