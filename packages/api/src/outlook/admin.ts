import { Router, json } from 'express';
import { generateKeyPairSync, privateDecrypt, constants, randomUUID } from 'node:crypto';
import { encryptV2, decryptV2 } from '@librechat/data-schemas';
import { z } from 'zod';
import { outlookAvailable, outlookServerName, OUTLOOK_SCOPES } from './policy';
import {
  GUID,
  outlookCollection,
  outlookScope,
  outlookSettings,
  settingsId,
  outlookAudit,
} from './runtime';
import { outlookRegistrationScript } from './registration';

const importSchema = z
  .object({
    registrationId: z.string().uuid(),
    tenantId: z.string().regex(GUID),
    clientId: z.string().regex(GUID),
    ciphertext: z
      .string()
      .min(100)
      .max(2000)
      .regex(/^[A-Za-z0-9+/]+=*$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const enableSchema = z.object({ generation: z.string().uuid(), enabled: z.boolean() }).strict();
const route = (action: (req: any, res: any) => Promise<unknown>) => (req: any, res: any) => {
  void action(req, res).catch(() => {
    if (!res.headersSent)
      res.status(400).json({
        error:
          'Die Outlook-Einrichtung konnte nicht abgeschlossen werden. Bitte Eingaben, Ablaufzeit und Administratorrechte prüfen.',
      });
  });
};
function callback() {
  const base = new URL(process.env.DOMAIN_SERVER || '');
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Die öffentliche HTTPS-Adresse fehlt.');
  return new URL(`/api/mcp/${outlookServerName()}/oauth/callback`, base).href;
}
export async function outlookAdminStatus(): Promise<{
  available: boolean;
  configured: boolean;
  enabled: boolean;
  generation?: string;
  tenantId?: string;
  clientId?: string;
  expiresAt?: Date;
  scopes: string[];
  consentVerified: boolean;
}> {
  const settings = await outlookSettings();
  return {
    available: outlookAvailable(),
    configured: !!settings?.encrypted,
    enabled: settings?.enabled === true,
    generation: settings?.generation,
    tenantId: settings?.tenantId,
    clientId: settings?.clientId,
    expiresAt: settings?.expiresAt,
    scopes: OUTLOOK_SCOPES.split(' '),
    consentVerified: settings?.consentVerified === true,
  };
}
/** Mount behind fresh native administrator and config-capability checks. */
export function createOutlookAdminRouter(): Router {
  const router = Router();
  router.use(json({ limit: '16kb' }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!outlookAvailable()) {
      res.status(404).json({ error: 'Outlook ist für diese Instanz nicht freigeschaltet.' });
      return;
    }
    next();
  });
  router.get(
    '/',
    route(async (_req, res) => res.json(await outlookAdminStatus())),
  );
  router.post(
    '/registration',
    route(async (req, res) => {
      const redirectUri = callback();
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const ownerId = String(req.user.id);
      await outlookAudit(ownerId, 'admin.registration.prepare');
      await outlookCollection().deleteMany({
        kind: 'registration',
        scope: outlookScope(),
        expiresAt: { $lt: new Date() },
      });
      await outlookCollection().insertOne({
        _id: `registration:${outlookScope()}:${id}` as never,
        kind: 'registration',
        scope: outlookScope(),
        encrypted: await encryptV2(JSON.stringify({ privateKey, ownerId, scope: outlookScope() })),
        expiresAt,
      });
      res.json({
        filename: 'Kisuno-Outlook-Registrierung.ps1',
        script: outlookRegistrationScript({ id, publicKey, redirectUri }),
        expiresAt,
      });
    }),
  );
  router.post(
    '/registration/import',
    route(async (req, res) => {
      const input = importSchema.parse(req.body);
      const expires = new Date(input.expiresAt).getTime();
      if (expires <= Date.now() || expires > Date.now() + 181 * 86400000)
        throw new Error('Ungültige Ablaufzeit.');
      const key = `registration:${outlookScope()}:${input.registrationId}`;
      const pending = await outlookCollection().findOne({
        _id: key as never,
        expiresAt: { $gt: new Date() },
      });
      if (!pending) throw new Error('Registrierung abgelaufen.');
      const privateData = JSON.parse(await decryptV2(pending.encrypted));
      if (privateData.ownerId !== String(req.user.id) || privateData.scope !== outlookScope())
        throw new Error('Fremde Registrierung.');
      const clientSecret = privateDecrypt(
        {
          key: privateData.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(input.ciphertext, 'base64'),
      ).toString('utf8');
      if (clientSecret.length < 16 || clientSecret.length > 256 || /\s/.test(clientSecret))
        throw new Error('Ungültiger Schlüssel.');
      await outlookAudit(String(req.user.id), 'admin.registration.import');
      const consumed = await outlookCollection().deleteOne({
        _id: key as never,
        encrypted: pending.encrypted,
      });
      if (consumed.deletedCount !== 1) throw new Error('Registrierung bereits verwendet.');
      const generation = randomUUID();
      await outlookCollection().updateOne(
        { _id: settingsId() as never },
        {
          $set: {
            tenantId: input.tenantId.toLowerCase(),
            clientId: input.clientId.toLowerCase(),
            expiresAt: new Date(input.expiresAt),
            generation,
            enabled: false,
            consentVerified: false,
            encrypted: await encryptV2(
              JSON.stringify({
                tenantId: input.tenantId.toLowerCase(),
                clientId: input.clientId.toLowerCase(),
                clientSecret,
                scope: outlookScope(),
                generation,
              }),
            ),
          },
        },
        { upsert: true },
      );
      res.json(await outlookAdminStatus());
    }),
  );
  router.put(
    '/',
    route(async (req, res) => {
      const input = enableSchema.parse(req.body);
      const settings = await outlookSettings();
      if (
        !settings?.encrypted ||
        settings.generation !== input.generation ||
        new Date(settings.expiresAt).getTime() <= Date.now()
      )
        return res.status(409).json({
          error: 'Die Einrichtung hat sich geändert oder ist abgelaufen. Bitte erneut laden.',
        });
      await outlookAudit(String(req.user.id), input.enabled ? 'admin.enable' : 'admin.disable');
      await outlookCollection().updateOne(
        { _id: settingsId() as never, generation: input.generation },
        { $set: { enabled: input.enabled } },
      );
      res.json(await outlookAdminStatus());
    }),
  );
  return router;
}
