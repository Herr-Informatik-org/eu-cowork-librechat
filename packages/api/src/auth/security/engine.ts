import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Assurance, RecoveryRecord, SecurityAccount, SecurityConfig } from './protocol';
import type { PasskeyChallengeStore, VerifiedPasskeyRegistration } from './passkey';
import {
  digest,
  opaque,
  recoveryCodes,
  recoveryHash,
  securityToken,
  validAssurance,
  verifySecurityToken,
  versionOf,
  matchingTotpStep,
} from './protocol';
import {
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './passkey';
import { securityPage } from './page';

export interface Credential extends VerifiedPasskeyRegistration {
  userId: string;
  name: string;
  slot: number;
  createdAt?: Date;
}
export interface Challenge {
  key: string;
  value: string;
  expiresAt: Date;
}
export interface SecurityStore extends PasskeyChallengeStore {
  account(id: string): Promise<SecurityAccount | null>;
  update(id: string, version: number, fields: Partial<SecurityAccount>): Promise<SecurityAccount>;
  credentials(id: string): Promise<Credential[]>;
  credential(id: string): Promise<Credential | null>;
  addCredential(value: Credential): Promise<void>;
  removeCredential(id: string, userId: string): Promise<void>;
  recordUse(id: string, previous: number, next: number, backedUp: boolean): Promise<boolean>;
  consumeRecovery(id: string, hash: string): Promise<boolean>;
  claimTotp(id: string, secretHash: string, step: number): Promise<boolean>;
  rate(key: string, maximum: number, windowMs: number): Promise<boolean>;
  withLock<T>(id: string, callback: () => Promise<T>): Promise<T>;
}
export interface SecurityDependencies {
  store: SecurityStore;
  config: SecurityConfig;
  encrypt(value: string): string;
  decrypt(value: string): string | null | Promise<string | null>;
  secret(): string;
  verifyTotp(secret: string, code: string): boolean | Promise<boolean>;
  issue(
    user: SecurityAccount,
    assurance: Assurance,
    req: Request,
    res: Response,
  ): Promise<{ token: string; user: object }>;
  admin(user: SecurityAccount): Promise<boolean>;
  audit?(user: SecurityAccount, action: string): Promise<void>;
}
interface Body {
  tempToken?: string;
  token?: string;
  backupCode?: string;
  portal?: string;
  email?: string;
  sessionId?: string;
  credential?: RegistrationResponseJSON & AuthenticationResponseJSON;
  name?: string;
  credentialId?: string;
}
type Actor = {
  user: SecurityAccount;
  proof?: Assurance;
  pending?: { nonce: string; tokenPurpose: string };
};
const failure = (
  message = 'Anmeldung fehlgeschlagen. Bitte erneut anmelden.',
  status = 401,
): Error & { status: number } => Object.assign(new Error(message), { status });
const disabled = (user: SecurityAccount | null): boolean =>
  !user || !!user.disabled || !!user.disabledAt;

export function createSecurityEngine(deps: SecurityDependencies): {
  router: Router;
  begin: (user: SecurityAccount, req: Request, res: Response) => Promise<Response>;
} {
  const { store, config } = deps;
  const passkeyConfig = {
    enabled: true,
    rpID: config.rpID,
    rpName: config.rpName,
    origins: config.origins,
  };
  const flowKey = (nonce: string) => 'mfa-flow:' + digest(nonce);
  const log = async (user: SecurityAccount, action: string) => {
    await deps.audit?.(user, action);
  };

  async function budget(req: Request, userId?: string, maximum = 7) {
    if (
      !(await store.rate('ip:' + digest(req.ip || 'local'), 300, 300_000)) ||
      (userId && !(await store.rate('account:' + maximum + ':' + digest(userId), maximum, 300_000)))
    )
      throw failure('Zu viele Versuche. Bitte in fünf Minuten erneut versuchen.', 429);
  }
  async function finish(
    user: SecurityAccount,
    method: Assurance['method'],
    req: Request,
    res: Response,
    extra: object = {},
  ) {
    if (disabled(user)) throw failure();
    if ((req.body as Body)?.portal === 'admin' && !(await deps.admin(user)))
      throw failure('Dieses Konto hat keine Berechtigung für die Verwaltung.', 403);
    const current = await store.account(user.id);
    if (disabled(current) || versionOf(current!) !== versionOf(user)) throw failure();
    await log(user, 'security.login.' + method);
    const result = await deps.issue(
      user,
      { method, verifiedAt: Date.now(), version: versionOf(user) },
      req,
      res,
    );
    return res.json({ ...result, ...extra });
  }
  async function begin(user: SecurityAccount, req: Request, res: Response) {
    if (disabled(user)) throw failure();
    const factors = await store.credentials(user.id);
    const setup = !user.twoFactorEnabled && factors.length === 0;
    const nonce = opaque();
    await store.set(
      flowKey(nonce),
      JSON.stringify({ id: user.id, version: versionOf(user), setup }),
      300_000,
    );
    res.set('Cache-Control', 'no-store');
    return res.json({
      twoFAPending: true,
      setupRequired: setup,
      tempToken: securityToken(config, user, nonce, setup),
      hasTotp: !!user.twoFactorEnabled,
      hasPasskey: factors.length > 0,
    });
  }
  async function actor(req: Request, fresh = false): Promise<Actor> {
    const body = req.body as Body;
    if (body.tempToken) {
      const p = verifySecurityToken(body.tempToken, config);
      if (!p) throw failure();
      const stored = await store.get(flowKey(p.nonce));
      const user = await store.account(p.userId);
      if (!stored || disabled(user) || versionOf(user!) !== p.version) throw failure();
      return { user: user!, pending: { nonce: p.nonce, tokenPurpose: p.tokenPurpose } };
    }
    const raw = (req.get('authorization') || '').replace(/^Bearer /, '');
    let p: jwt.JwtPayload;
    try {
      const value = jwt.verify(raw, config.secret, { algorithms: ['HS256'] });
      if (typeof value === 'string') throw failure();
      p = value;
    } catch {
      throw failure();
    }
    const id = p.id || p.sub;
    if (typeof id !== 'string' || p.tokenPurpose) throw failure();
    const user = await store.account(id);
    const proof = p.mfa as Assurance | undefined;
    if (
      disabled(user) ||
      !validAssurance(proof, user!) ||
      (fresh && proof!.verifiedAt < Date.now() - 300_000)
    )
      throw failure('Bitte für diese Sicherheitsänderung erneut mit 2FA oder Passkey anmelden.');
    return { user: user!, proof };
  }
  async function manage(a: Actor) {
    if (a.proof?.method === 'operator')
      throw failure('Sicherheitsmerkmale bitte mit dem eigenen Konto verwalten.', 403);
    if (a.proof) return;
    const credentials = await store.credentials(a.user.id);
    if (a.pending?.tokenPurpose !== 'mfa-setup' || a.user.twoFactorEnabled || credentials.length)
      throw failure();
  }
  async function consume(a: Actor) {
    if (a.pending && !(await store.delete(flowKey(a.pending.nonce)))) throw failure();
  }
  const route =
    (fn: (req: Request, res: Response) => Promise<Response | void>) =>
    async (req: Request, res: Response) => {
      res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      try {
        const origin = req.get('origin');
        if (req.method !== 'GET' && (!origin || !config.origins.includes(origin)))
          throw failure('Diese Anmeldeadresse ist nicht freigegeben.', 403);
        await fn(req, res);
      } catch (error) {
        const e = error as Error & { status?: number };
        if (!res.headersSent)
          res.status(e.status || 503).json({
            code: e.status === 429 ? 'SECURITY_RATE_LIMITED' : 'SECURITY_FAILED',
            message: e.status
              ? e.message
              : 'Sicherheitsprüfung ist vorübergehend nicht verfügbar. Bitte erneut versuchen.',
          });
      }
    };
  const router = Router();
  router.get('/page', (req, res) => {
    const portal = req.query.portal === 'admin' ? 'admin' : 'chat';
    const html = securityPage({
      name: config.rpName,
      portal,
      manage: req.query.manage === '1',
      email: typeof req.query.email === 'string' ? req.query.email : '',
      storage: config.storage,
    });
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': html.policy,
    });
    res.type('html').send(html.body);
  });
  router.post(
    '/verify',
    route(async (req, res) => {
      const a = await actor(req);
      await budget(req, a.user.id);
      if (!a.pending || a.pending.tokenPurpose !== 'mfa-login') throw failure();
      const body = req.body as Body;
      let method: Assurance['method'] = 'totp';
      if (body.backupCode) {
        method = 'recovery';
        if (
          !/^[0-9a-fA-F-]{8,40}$/.test(body.backupCode) ||
          !(await store.consumeRecovery(a.user.id, recoveryHash(body.backupCode)))
        )
          throw failure('Code ist ungültig oder bereits benutzt.');
      } else {
        const secret = await deps.decrypt(a.user.totpSecret || '');
        if (
          !a.user.twoFactorEnabled ||
          !secret ||
          !(await deps.verifyTotp(secret, body.token || ''))
        )
          throw failure('Authenticator-Code ist ungültig.');
        const step = matchingTotpStep(secret, body.token || '');
        if (step === null || !(await store.claimTotp(a.user.id, digest(secret), step)))
          throw failure('Dieser Code wurde bereits verwendet. Bitte den nächsten Code abwarten.');
      }
      await consume(a);
      return finish(a.user, method, req, res);
    }),
  );
  router.post(
    '/totp/start',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id, 20);
      await manage(a);
      const secret = deps.secret();
      await store.withLock(a.user.id, async () => {
        const current = await store.account(a.user.id);
        if (!current || versionOf(current) !== versionOf(a.user)) throw failure();
        await store.update(a.user.id, versionOf(a.user), {
          pendingTotpSecret: deps.encrypt(secret),
          pendingTotpExpires: new Date(Date.now() + 600_000),
        });
      });
      const url =
        'otpauth://totp/' +
        encodeURIComponent(config.rpName + ':' + a.user.email) +
        '?secret=' +
        secret +
        '&issuer=' +
        encodeURIComponent(config.rpName);
      return res.json({
        secret,
        qr: await QRCode.toDataURL(url, { width: 240, errorCorrectionLevel: 'M' }),
      });
    }),
  );
  router.post(
    '/totp/confirm',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id);
      await manage(a);
      const codes = recoveryCodes();
      const updated = await store.withLock(a.user.id, async () => {
        const user = await store.account(a.user.id);
        if (
          !user ||
          versionOf(user) !== versionOf(a.user) ||
          !user.pendingTotpSecret ||
          !user.pendingTotpExpires ||
          new Date(user.pendingTotpExpires).getTime() < Date.now()
        )
          throw failure();
        const secret = await deps.decrypt(user.pendingTotpSecret);
        if (!secret || !(await deps.verifyTotp(secret, (req.body as Body).token || '')))
          throw failure('Authenticator-Code ist ungültig.');
        const step = matchingTotpStep(secret, (req.body as Body).token || '');
        if (step === null || !(await store.claimTotp(user.id, digest(secret), step)))
          throw failure('Dieser Code wurde bereits verwendet. Bitte den nächsten Code abwarten.');
        await consume(a);
        return store.update(user.id, versionOf(user), {
          totpSecret: user.pendingTotpSecret,
          twoFactorEnabled: true,
          securityEnrolled: true,
          pendingTotpSecret: '',
          pendingTotpExpires: new Date(0),
          backupCodes: codes.records,
          securityVersion: versionOf(user) + 1,
        });
      });
      await log(updated, 'security.totp.enrolled');
      return finish(updated, 'totp', req, res, { backupCodes: codes.plain });
    }),
  );
  router.post(
    '/passkeys/options',
    route(async (req, res) => {
      await budget(req, undefined, 20);
      const options = await createPasskeyAuthenticationOptions({ config: passkeyConfig, store });
      const email = (req.body as Body).email;
      if (typeof email === 'string' && email.trim()) {
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
          throw failure('Bitte eine gültige E-Mail eingeben.', 400);
        await store.set('passkey-email:' + options.sessionId, email.trim().toLowerCase(), 300000);
      }
      return res.json(options);
    }),
  );
  router.post(
    '/passkeys/verify',
    route(async (req, res) => {
      await budget(req, undefined, 20);
      const body = req.body as Body;
      if (
        !body.credential ||
        typeof body.credential.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,2048}$/.test(body.credential.id) ||
        typeof body.sessionId !== 'string'
      )
        throw failure();
      const credential = await store.credential(body.credential.id);
      if (!credential) throw failure();
      const user = await store.account(credential.userId);
      if (disabled(user)) throw failure();
      const expectedEmail = await store.get('passkey-email:' + body.sessionId);
      if (expectedEmail && expectedEmail !== user!.email.toLowerCase())
        throw failure(
          'Dieser Passkey gehört zu einer anderen E-Mail. Bitte das passende Konto wählen.',
        );
      await budget(req, user!.id);
      const handle = body.credential.response.userHandle;
      if (!handle || Buffer.from(handle, 'base64url').toString('utf8') !== user!.id)
        throw failure();
      const verified = await verifyPasskeyAuthentication({
        config: passkeyConfig,
        store,
        sessionId: body.sessionId,
        response: body.credential,
        credential,
      });
      if (
        !verified ||
        !(await store.recordUse(
          credential.credentialId,
          credential.counter,
          verified.newCounter,
          verified.backedUp,
        ))
      )
        throw failure();
      await store.delete('passkey-email:' + body.sessionId);
      return finish(user!, 'passkey', req, res);
    }),
  );
  router.post(
    '/passkeys/register/options',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id, 20);
      await manage(a);
      const credentials = await store.credentials(a.user.id);
      if (credentials.length >= 20) throw failure('Höchstens 20 Passkeys pro Konto.', 409);
      return res.json(
        await createPasskeyRegistrationOptions({
          config: passkeyConfig,
          store,
          user: a.user,
          existingCredentials: credentials,
        }),
      );
    }),
  );
  router.post(
    '/passkeys/register/verify',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id, 20);
      await manage(a);
      const body = req.body as Body;
      if (!body.credential) throw failure();
      const verified = await verifyPasskeyRegistration({
        config: passkeyConfig,
        store,
        userId: a.user.id,
        response: body.credential,
      });
      if (!verified)
        throw failure('Passkey konnte nicht bestätigt werden. Bitte erneut versuchen.');
      let codes: ReturnType<typeof recoveryCodes> | undefined;
      const updated = await store.withLock(a.user.id, async () => {
        const user = await store.account(a.user.id);
        if (!user || versionOf(user) !== versionOf(a.user)) throw failure();
        const existing = await store.credentials(user.id);
        if (existing.length >= 20) throw failure('Höchstens 20 Passkeys pro Konto.', 409);
        const slot = Array.from({ length: 20 }, (_, i) => i).find(
          (i) => !existing.some((key) => key.slot === i),
        )!;
        const first = !user.twoFactorEnabled && !existing.length;
        if (first) codes = recoveryCodes();
        await consume(a);
        await store.addCredential({
          ...verified,
          userId: user.id,
          slot,
          name: (body.name || 'Passkey / FIDO2').trim().slice(0, 60),
        });
        try {
          return await store.update(user.id, versionOf(user), {
            securityVersion: versionOf(user) + 1,
            securityEnrolled: true,
            ...(codes ? { backupCodes: codes.records } : {}),
          });
        } catch (error) {
          await store.removeCredential(verified.credentialId, user.id);
          throw error;
        }
      });
      await log(updated, 'security.passkey.enrolled');
      return finish(updated, 'passkey', req, res, codes ? { backupCodes: codes.plain } : {});
    }),
  );
  router.post(
    '/status',
    route(async (req, res) => {
      const a = await actor(req);
      const keys = await store.credentials(a.user.id);
      return res.json({
        email: a.user.email,
        hasTotp: !!a.user.twoFactorEnabled,
        passkeys: keys.map((k) => ({ id: k.credentialId, name: k.name, createdAt: k.createdAt })),
      });
    }),
  );
  router.post(
    '/recovery/regenerate',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id);
      await manage(a);
      if (!a.proof) throw failure();
      const codes = recoveryCodes();
      const user = await store.withLock(a.user.id, () =>
        store.update(a.user.id, versionOf(a.user), {
          backupCodes: codes.records,
          securityVersion: versionOf(a.user) + 1,
        }),
      );
      await log(user, 'security.recovery.regenerated');
      return finish(user, a.proof!.method, req, res, { backupCodes: codes.plain });
    }),
  );
  router.post(
    '/totp/remove',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id);
      await manage(a);
      if (!a.proof) throw failure();
      const user = await store.withLock(a.user.id, async () => {
        if (!(await store.credentials(a.user.id)).length)
          throw failure('Zuerst einen Passkey einrichten.', 409);
        return store.update(a.user.id, versionOf(a.user), {
          twoFactorEnabled: false,
          totpSecret: '',
          pendingTotpSecret: '',
          pendingTotpExpires: new Date(0),
          securityVersion: versionOf(a.user) + 1,
        });
      });
      await log(user, 'security.totp.removed');
      return finish(user, a.proof!.method, req, res);
    }),
  );
  router.post(
    '/passkeys/remove',
    route(async (req, res) => {
      const a = await actor(req, true);
      await budget(req, a.user.id);
      await manage(a);
      if (!a.proof) throw failure();
      const id = (req.body as Body).credentialId;
      const updated = await store.withLock(a.user.id, async () => {
        const user = await store.account(a.user.id);
        if (!user || versionOf(user) !== versionOf(a.user)) throw failure();
        const keys = await store.credentials(user.id);
        if (!keys.some((k) => k.credentialId === id))
          throw failure('Passkey wurde nicht gefunden.', 404);
        if (!user.twoFactorEnabled && keys.length <= 1)
          throw failure('Zuerst einen zweiten Passkey oder Authenticator einrichten.', 409);
        const next = await store.update(user.id, versionOf(user), {
          securityVersion: versionOf(user) + 1,
        });
        await store.removeCredential(id!, user.id);
        return next;
      });
      await log(updated, 'security.passkey.removed');
      return finish(updated, a.proof!.method, req, res);
    }),
  );
  return { router, begin };
}
