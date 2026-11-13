import { Router } from 'express';
import { z } from 'zod';
import { notebookRequest, notebooksEnabled } from './client';

/** Public OAuth return surface: all identity and source mutations require single-use PKCE state. */
export function createNotebookMicrosoftRouter(deps:{getUserById:(id:string)=>Promise<{role?:string}|null>}): Router {
  const router = Router();
  const actor = { id: 'microsoft_callback', role: 'USER' as const, room: '', permissions: 0 };
  const cookieName = '__Host-kisuno-notebook-microsoft';
  const cookie = { secure: true, httpOnly: true, sameSite: 'lax' as const, path: '/' };
  const limits = new Map<string, { count: number; until: number }>();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (!notebooksEnabled()) return void res.sendStatus(404);
    for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
    const key = req.ip ?? 'unknown';
    const limit = limits.get(key) ?? { count: 0, until: Date.now() + 60_000 };
    if (limit.count >= 30 || (!limits.has(key) && limits.size >= 1000)) return void res.status(429).send('Bitte die Microsoft-Anmeldung in einer Minute erneut versuchen.');
    limit.count += 1;
    limits.set(key, limit);
    next();
  });
  router.get('/start', (req, res) => {
    void (async () => {
      const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.query.code);
      const result = await notebookRequest(actor, '/oauth/start', 'POST', z.object({ url: z.string().url(), cookie: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), { code });
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.hostname !== 'login.microsoftonline.com') throw new Error();
      res.cookie(cookieName, result.cookie, { ...cookie, maxAge: 600_000 });
      res.redirect(303, target.href);
    })().catch(() => res.status(400).type('text').send('Der Microsoft-Anmeldelink ist ungültig oder abgelaufen. Bitte im Wissensraum neu starten.'));
  });
  router.get('/callback', (req, res) => {
    void (async () => {
      const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(10000), cookie: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse({ state: req.query.state, code: req.query.code, cookie: req.cookies?.[cookieName] });
      const context=await notebookRequest(actor,'/oauth/context','POST',z.object({userId:z.string(),purpose:z.enum(['identity','setup'])}),{state:input.state,cookie:input.cookie});
      const user=await deps.getUserById(context.userId);
      if(!user || (context.purpose==='setup' && user.role!=='ADMIN')) throw new Error();
      const result=await notebookRequest({...actor,id:context.userId,role:user.role==='ADMIN'?'ADMIN':'USER'},'/oauth/callback','POST',z.object({connected:z.literal(true),setup:z.boolean().optional(),sourceId:z.string().uuid().optional()}),input);
      res.clearCookie(cookieName, cookie);
      if(result.setup) {
        const panel=new URL(process.env.NOTEBOOKS_ADMIN_URL ?? '');
        if(panel.protocol!=='https:' || panel.username || panel.password) throw new Error();
        res.redirect(303,panel.origin+'/wissensquellen'+(result.sourceId?'?source='+encodeURIComponent(result.sourceId):''));
      } else res.redirect(303, '/wissensraeume');
    })().catch(() => {
      res.clearCookie(cookieName, cookie);
      res.status(400).type('text').send('Die Microsoft-Anmeldung wurde nicht bestätigt. Bitte den Wissensraum öffnen und erneut verbinden. Es wurden keine Quellrechte erweitert.');
    });
  });
  return router;
}

/** Agent pairing never uses native browser cookies; every later operation requires the paired HMAC. */
export function createNotebookWindowsRouter(): Router {
  const router=Router();
  const actor={id:'windows_callback',role:'USER' as const,room:'',permissions:0};
  const limits=new Map<string,{count:number;until:number}>();
  router.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'});
    if(!notebooksEnabled()) return void res.sendStatus(404);
    for(const [key,value] of limits) if(value.until<Date.now()) limits.delete(key);
    const key=req.ip ?? 'unknown',limit=limits.get(key) ?? {count:0,until:Date.now()+60000};
    if(limit.count>=120 || (!limits.has(key)&&limits.size>=1000)) return void res.sendStatus(429);
    limit.count++;limits.set(key,limit);next();
  });
  router.post('/:operation',(req,res)=>{
    void(async()=>{
      const operation=z.enum(['pair','poll','result']).parse(req.params.operation);
      const body=z.record(z.unknown()).parse(req.body);
      res.json(await notebookRequest(actor,'/agent/'+operation,'POST',z.record(z.unknown()),body));
    })().catch(()=>res.status(403).json({error:'Die Windows-Kopplung oder der signierte Auftrag wurde nicht bestätigt.'}));
  });
  return router;
}
