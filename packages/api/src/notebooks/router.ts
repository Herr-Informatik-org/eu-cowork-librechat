import { Router } from 'express';
import { z } from 'zod';
import { AccessRoleIds, PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { NextFunction, Response, RequestHandler } from 'express';
import type { IUser, UserMethods } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import type { NotebookActor } from './client';
import { NotebookError, notebookRequest, notebooksEnabled } from './client';
import { notebookModelSelection } from './model';

type NotebookRequest = ServerRequest & { params: Record<string, string> };
const id = z.string().regex(/^[a-f0-9]{24}$/);
const sourceId = z.string().uuid();
const externalIdentity=z.string().regex(/^([0-9a-fA-F-]{36}|S-1-[0-9-]{3,180})$/);
const zone = z.enum(['lokal', 'schweiz', 'europa', 'global']);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const json = z.record(jsonValue);
const room = z.object({ id, name: z.string(), zone });
const list = z.object({ rooms: z.array(room) });
const evidenceSchema = z.object({
  anchor: z.string().regex(/^q[0-9]+$/),
  documentId: sourceId,
  version: z.string(),
  ordinal: z.number(),
  hash: z.string(),
  title: z.string(),
  position: z.string(),
  text: z.string(),
  sourceId,
  zone,
  webUrl: z.string().nullable().optional(),
  authorizedAt: z.string(),
});
const queryResultSchema = z.object({
  ticket: sourceId,
  evidence: z.array(evidenceSchema),
  sources: z.array(json),
  partial: z.boolean(),
  checkedAt: z.string(),
  notice: z.string(),
});
export interface NotebookEvidence {
  anchor: string; documentId: string; version: string; ordinal: number; hash: string;
  title: string; position: string; text: string; sourceId: string;
  zone: 'lokal' | 'schweiz' | 'europa' | 'global'; webUrl?: string | null; authorizedAt: string;
}
export interface NotebookQueryResult {
  ticket: string; evidence: NotebookEvidence[]; sources: { [key: string]: JsonValue }[];
  partial: boolean; checkedAt: string; notice: string;
}

interface PermissionInput {
  userId: string;
  role?: string;
  resourceType: string;
}
export interface NotebookDependencies {
  getUserById: UserMethods['getUserById'];
  canUse: (user: IUser) => Promise<boolean>;
  permissions: (args: PermissionInput & { resourceId: string }) => Promise<number>;
  list: (args: PermissionInput & { requiredPermissions: number }) => Promise<Array<{ toString(): string }>>;
  grant: (args: { principalType: PrincipalType; principalId: string; resourceType: string; resourceId: string; accessRoleId: AccessRoleIds; grantedBy: string }) => Promise<object | null>;
  remove: (args: { resourceType: string; resourceId: string }) => Promise<object | void>;
  answer: (req: ServerRequest, result: NotebookQueryResult, question: string, modelSpec?: string) => Promise<string>;
}

export function createNotebooksRouter(deps: NotebookDependencies): Router {
  const router = Router();
  const handle = (fn: (req: NotebookRequest, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) => { void Promise.resolve(fn(req as NotebookRequest, res)).catch(next); };
  router.use((request, res, next) => {
    const req = request as NotebookRequest;
    void (async () => {
    res.set('Cache-Control', 'no-store, private');
    if (!notebooksEnabled()) throw new NotebookError(404, 'Wissensräume sind nicht aktiviert.');
    const userId = String(req.user?.id ?? '');
    const fresh = userId && await deps.getUserById(userId);
    if (!fresh) throw new NotebookError(401, 'Bitte erneut anmelden.');
    req.user = Object.assign(fresh, { id: userId });
    if (!req.path.startsWith('/admin') && !(await deps.canUse(req.user)))
      throw new NotebookError(403, 'Die Dateisuche ist für dieses Konto nicht freigegeben.');
    })().then(() => next()).catch(next);
  });
  router.use((request, res, next) => {
    const req = request as NotebookRequest;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const expected = process.env.DOMAIN_CLIENT;
      const origin = req.get('origin');
      if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expected)) {
        res.status(403).json({ error: 'Bitte Wissensräume direkt in Kisuno öffnen.' });
        return;
      }
    }
    next();
  });
  const actor = async (req: ServerRequest, roomId = ''): Promise<NotebookActor> => ({
    id: String(req.user!.id),
    role: req.user!.role === 'ADMIN' ? 'ADMIN' : 'USER',
    room: roomId,
    permissions: roomId
      ? await deps.permissions({ userId: String(req.user!.id), role: req.user!.role, resourceType: ResourceType.NOTEBOOK, resourceId: roomId })
      : 0,
  });
  router.get('/status', handle(async (req, res) => {
    const selected = notebookModelSelection(req);
    res.json({ available: true, pilot: true, modelZone: selected.zone, modelName: selected.spec?.label ?? selected.spec?.name ?? null, models: (req.config?.modelSpecs?.list ?? []).filter((item) => (!process.env.NOTEBOOKS_MODEL_SPEC || item.name===process.env.NOTEBOOKS_MODEL_SPEC) && item.name && item.showInMenu !== false && item.preset?.model && item.preset.endpoint !== 'agents').map((item) => ({ name: item.name, label: item.label ?? item.name, zone: notebookModelSelection(req, item.name).zone })) });
  }));
  router.get('/rooms', handle(async (req, res) => {
    const ids = await deps.list({ userId: String(req.user!.id), role: req.user!.role, resourceType: ResourceType.NOTEBOOK, requiredPermissions: PermissionBits.VIEW });
    res.json(await notebookRequest(await actor(req), '/rooms/list', 'POST', list, { allowedIds: ids.map(String) }));
  }));
  router.post('/rooms', handle(async (req, res) => {
    const input = z.object({ name: z.string().min(1).max(100), zone }).strict().parse(req.body);
    const created = await notebookRequest(await actor(req), '/rooms', 'POST', room, input);
    const granted = await deps.grant({ principalType: PrincipalType.USER, principalId: String(req.user!.id), resourceType: ResourceType.NOTEBOOK, resourceId: created.id, accessRoleId: AccessRoleIds.NOTEBOOK_OWNER, grantedBy: String(req.user!.id) });
    if (!granted) throw new NotebookError(503, 'Der Wissensraum konnte nicht sicher freigegeben werden.');
    res.status(201).json(created);
  }));
  router.get('/rooms/:id', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    res.json(await notebookRequest(await actor(req, roomId), '/rooms/'+roomId, 'GET', room));
  }));
  for (const suffix of ['documents', 'history','sources'] as const) {
    router.get('/rooms/:id/'+suffix, handle(async (req, res) => {
      const roomId = id.parse(req.params.id);
      res.json(await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/${suffix}`+(suffix==='documents' && req.query.after ? '?after='+sourceId.parse(req.query.after) : ''), 'GET', json));
    }));
  }
  router.post('/rooms/:id/tickets/:ticket/access', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const ticket = sourceId.parse(req.params.ticket);
    res.json(await notebookRequest(await actor(req,roomId), `/rooms/${roomId}/tickets/${ticket}/access`, 'POST', z.object({ valid:z.boolean() }), {}));
  }));
  router.post('/rooms/:id/upload', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const input = z.object({ name: z.string().min(1).max(150), text: z.string().min(1).max(500000), dataClass: z.enum(['gesperrt','lokal','schweiz','europa','offen']) }).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/upload`, 'POST', json, input));
  }));
  router.post('/rooms/:id/sources/:sourceId/microsoft',handle(async(req,res)=>{
    const roomId=id.parse(req.params.id), source=sourceId.parse(req.params.sourceId);
    res.json(await notebookRequest(await actor(req,roomId),`/rooms/${roomId}/sources/${source}/microsoft`,'POST',z.object({url:z.string().url()}),{}));
  }));
  router.post('/rooms/:id/file', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const input = z.object({ name:z.string().min(1).max(150),contentBase64:z.string().min(4).max(1000000),dataClass:z.enum(['gesperrt','lokal','schweiz','europa','offen']) }).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req,roomId),`/rooms/${roomId}/file`,'POST',json,input));
  }));
  router.post('/rooms/:id/rename', handle(async (req,res) => {
    const roomId=id.parse(req.params.id);
    const input=z.object({name:z.string().trim().min(1).max(100)}).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req,roomId),`/rooms/${roomId}/rename`,'POST',json,input));
  }));
  router.post('/rooms/:id/query', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const input = z.object({ query: z.string().min(1).max(2000), answer: z.boolean().default(false), modelSpec: z.string().min(1).max(120).optional(), sourceIds:z.array(sourceId).max(50).optional() }).strict().parse(req.body);
    const selected = notebookModelSelection(req, input.modelSpec);
    const localQuery = () => notebookRequest(actorValue, `/rooms/${roomId}/query`, 'POST', queryResultSchema, { query: input.query, zone: 'lokal', limit: 8,sourceIds:input.sourceIds });
    const actorValue = await actor(req, roomId);
    let result: NotebookQueryResult;
    try {
      result = await notebookRequest(actorValue, `/rooms/${roomId}/query`, 'POST', queryResultSchema, { query: input.query, zone: input.answer ? selected.zone : 'lokal', limit: 8,sourceIds:input.sourceIds });
    } catch (error) {
      if (!input.answer || !(error instanceof NotebookError) || error.status !== 403) throw error;
      result = await localQuery();
      return void res.json({ ...result, answerOmitted: true, notice: 'Das Antwortmodell liegt ausserhalb der Raumgrenze. Hier sind ausschliesslich lokal abgerufene, persönlich freigegebene Auszüge.' });
    }
    if (!input.answer) return void res.json(result);
    if (!result.evidence.length && selected.zone !== 'lokal') {
      result = await localQuery();
      return void res.json({ ...result, answerOmitted: true, notice: 'Für dieses Antwortmodell ist keine Quelle freigegeben. Hier sind ausschliesslich lokal abgerufene, persönlich freigegebene Auszüge.' });
    }
    if (!result.evidence.length) return void res.json(result);
    await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/tickets/${result.ticket}/verify`, 'POST', z.object({ valid: z.literal(true) }), {});
    let text: string;
    try {
      text = await deps.answer(req, result, input.query, input.modelSpec);
    } catch {
      await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/tickets/${result.ticket}/verify`, 'POST', z.object({ valid: z.literal(true) }), {});
      return void res.json({ ...result, answerOmitted: true, notice: 'Das Antwortmodell ist im Moment nicht sicher nutzbar. Die angezeigten Auszüge wurden lokal abgerufen und erneut persönlich freigegeben.' });
    }
    const fresh = await deps.getUserById(String(req.user!.id));
    if (!fresh) throw new NotebookError(401, 'Das Benutzerkonto ist nicht mehr verfügbar.');
    req.user = Object.assign(fresh, { id: String(req.user!.id) });
    const saved = await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/complete`, 'POST', json, { ticket: result.ticket, answer: text, citations: [...new Set([...text.matchAll(/\[(q\d+)\]/g)].map((match) => match[1]))] });
    res.json({ ...result, ...saved });
  }));
  router.delete('/rooms/:id', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const result = await notebookRequest(await actor(req, roomId), `/rooms/${roomId}`, 'DELETE', json);
    await deps.remove({ resourceType: ResourceType.NOTEBOOK, resourceId: roomId });
    res.json(result);
  }));
  router.post('/rooms/:id/share', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const caller = await actor(req, roomId);
    if (!(caller.permissions & PermissionBits.SHARE)) throw new NotebookError(403, 'Freigaberecht erforderlich.');
    const input = z.object({ principalId: id, principalType: z.enum([PrincipalType.USER, PrincipalType.GROUP]), editor: z.boolean().default(false) }).strict().parse(req.body);
    const grant = await deps.grant({ principalType: input.principalType, principalId: input.principalId, resourceType: ResourceType.NOTEBOOK, resourceId: roomId, accessRoleId: input.editor ? AccessRoleIds.NOTEBOOK_EDITOR : AccessRoleIds.NOTEBOOK_VIEWER, grantedBy: caller.id });
    if (!grant) throw new NotebookError(503, 'Die Freigabe wurde nicht gespeichert.');
    res.json({ shared: true });
  }));
  router.use('/admin', (request, _res, next) => {
    const req = request as NotebookRequest;
    if (req.user!.role !== 'ADMIN') return next(new NotebookError(403, 'Administratorberechtigung erforderlich.'));
    next();
  });
  router.get('/admin/status', handle(async (req, res) => {
    res.json(await notebookRequest(await actor(req), '/admin/status', 'GET', json));
  }));
  router.get('/admin/microsoft/status',handle(async(req,res)=>{
    res.json(await notebookRequest(await actor(req),'/admin/microsoft/status','GET',json));
  }));
  router.post('/admin/microsoft/bootstrap',handle(async(req,res)=>{
    const input=z.union([z.object({}).strict(),z.object({tenantId:sourceId,clientId:sourceId}).strict()]).parse(req.body);
    res.json(await notebookRequest(await actor(req),'/admin/microsoft/bootstrap','POST',json,input));
  }));
  router.get('/admin/windows/package',handle(async(req,res)=>{
    res.json(await notebookRequest(await actor(req),'/admin/windows/package','GET',json));
  }));
  router.get('/admin/sources/:sourceId/agents',handle(async(req,res)=>{
    const source=sourceId.parse(req.params.sourceId);
    res.json(await notebookRequest(await actor(req),`/admin/sources/${source}/agents`,'GET',json));
  }));
  router.get('/rooms/:id/documents/:sourceId/preview',handle(async(req,res)=>{
    const roomId=id.parse(req.params.id),document=sourceId.parse(req.params.sourceId),ordinal=z.coerce.number().int().min(0).max(5000).parse(req.query.ordinal ?? 0);
    res.json(await notebookRequest(await actor(req,roomId),`/rooms/${roomId}/documents/${document}/preview?ordinal=${ordinal}`,'GET',json));
  }));
  router.post('/rooms/:id/answers/:sourceId/export',handle(async(req,res)=>{
    const roomId=id.parse(req.params.id),answer=sourceId.parse(req.params.sourceId);
    res.json(await notebookRequest(await actor(req,roomId),`/rooms/${roomId}/answers/${answer}/export`,'POST',json,{}));
  }));
  router.post('/admin/setup',handle(async(req,res)=>{
    const input=z.object({name:z.string().min(1).max(100),siteUrl:z.string().url().max(2048),libraryPath:z.string().min(1).max(200).optional(),folderPath:z.string().min(1).max(1024).optional(),ceiling:z.enum(['gesperrt','lokal','schweiz','europa','offen'])}).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req),'/admin/setup','POST',json,input));
  }));
  router.get('/admin/sources/:sourceId/setup',handle(async(req,res)=>{
    const source=sourceId.parse(req.params.sourceId);
    res.json(await notebookRequest(await actor(req),`/admin/sources/${source}/setup`,'GET',json));
  }));
  router.post('/admin/documents/review',handle(async(req,res)=>{
    const input=z.object({documents:z.array(z.object({id:sourceId,version:z.string().min(1).max(256)}).strict()).min(1).max(100),dataClass:z.enum(['gesperrt','lokal','schweiz','europa','offen']),preview:z.boolean().default(true)}).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req),'/admin/documents/review','POST',json,input));
  }));
  router.post('/admin/documents/:sourceId/retry',handle(async(req,res)=>{
    const document=sourceId.parse(req.params.sourceId);
    const input=z.object({expectedVersion:z.string().min(1).max(256)}).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req),`/admin/documents/${document}/retry`,'POST',json,input));
  }));
  router.post('/admin/sources', handle(async (req, res) => {
    const input = z.object({ kind: z.enum(['sharepoint','dfs']), name: z.string().min(1).max(100), config: json }).strict().parse(req.body);
    res.status(201).json(await notebookRequest(await actor(req), '/admin/sources', 'POST', json, input));
  }));
  router.post('/admin/identities', handle(async (req, res) => {
    const input = z.object({ sourceId, userId: id, objectId: externalIdentity }).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req), '/admin/identities', 'POST', json, input));
  }));
  router.post('/admin/sources/:sourceId/:operation', handle(async (req, res) => {
    const source = sourceId.parse(req.params.sourceId);
    const operation = z.enum(['probe','pause','acceptance','discover','library','setup-complete','pair','agent-approve','microsoft']).parse(req.params.operation);
    const body = operation === 'acceptance' ? json.parse(req.body) : operation === 'library' ? z.object({ driveId: z.string().min(1).max(256),folderPath:z.string().min(1).max(1024) }).strict().parse(req.body) : operation==='setup-complete' ? z.object({tenantId:sourceId,clientId:sourceId}).strict().parse(req.body) : operation==='microsoft' ? z.object({roomId:id}).strict().parse(req.body) : operation==='agent-approve' ? z.object({agentId:sourceId,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body) : {};
    res.json(await notebookRequest(await actor(req,operation==='microsoft' ? (body as {roomId:string}).roomId : ''), `/admin/sources/${source}/${operation}`, 'POST', json, body));
  }));
  router.post('/admin/rooms/:id/sources', handle(async (req, res) => {
    const roomId = id.parse(req.params.id);
    const input = z.object({ sourceId }).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req, roomId), `/rooms/${roomId}/sources`, 'POST', json, input));
  }));
  router.post('/admin/documents/:sourceId/classify', handle(async (req, res) => {
    const document = sourceId.parse(req.params.sourceId);
    const body = z.object({ dataClass: z.enum(['gesperrt','lokal','schweiz','europa','offen']), expectedVersion: z.string().min(1).max(256) }).strict().parse(req.body);
    res.json(await notebookRequest(await actor(req), `/admin/documents/${document}/classify`, 'POST', json, body));
  }));
  router.use((error: Error, _req: import('express').Request, res: Response, _next: NextFunction) => {
    const status = error instanceof NotebookError ? error.status : error instanceof z.ZodError ? 400 : 503;
    res.status(status).json({ error: error instanceof NotebookError ? error.message : 'Die Wissensraumoperation konnte nicht sicher abgeschlossen werden.' });
  });
  return router;
}
