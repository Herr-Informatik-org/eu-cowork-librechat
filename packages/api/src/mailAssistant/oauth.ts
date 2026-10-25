import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { MailFetch } from './types';

export const MAIL_ASSISTANT_SCOPES = 'User.Read Mail.ReadWrite offline_access';
const acceptedScopes = new Set(MAIL_ASSISTANT_SCOPES.split(' '));
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class MailAuthorizationError extends Error {
  constructor(message = 'Bitte verbinde dein eigenes Microsoft-Postfach erneut.') {
    super(message);
    this.name = 'MailAuthorizationError';
  }
}
export interface MailIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
}
export interface MailOAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  callback: string;
}
export interface MailCredential {
  _id: string;
  generation: string;
  tenantId: string;
  clientId: string;
  mailboxId: string;
  email: string;
  ciphertext: string;
  expiresAt: Date;
  refreshLease?: Date;
}
export interface MailOAuthState {
  _id: string;
  ownerId: string;
  generation: string;
  ciphertext: string;
  expiresAt: Date;
}
interface TokenSet {
  accessToken: string;
  refreshToken: string;
  ownerId: string;
  tenantId: string;
  mailboxId: string;
}
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface GraphIdentity {
  id?: string;
  mail?: string | null;
  userPrincipalName?: string;
}
interface OAuthDependencies {
  credentials: () => Collection<MailCredential>;
  states: () => Collection<MailOAuthState>;
  authorize: (ownerId: string) => Promise<MailIdentity>;
  audit: (ownerId: string, event: string) => Promise<void>;
  codec: {
    seal(owner: string, purpose: string, value: object): string;
    open<T>(owner: string, purpose: string, value: string): T;
  };
  fetch?: MailFetch;
  now?: () => number;
}

export function readMailOAuthConfig(env: NodeJS.ProcessEnv = process.env): MailOAuthConfig {
  const {
    MAIL_ASSISTANT_TENANT_ID: tenantId = '',
    MAIL_ASSISTANT_CLIENT_ID: clientId = '',
    MAIL_ASSISTANT_CLIENT_SECRET: clientSecret = '',
    DOMAIN_SERVER: domain = '',
  } = env;
  if (!guid.test(tenantId) || !guid.test(clientId) || !clientSecret)
    throw new MailAuthorizationError(
      'Die persönliche Microsoft-Anbindung ist noch nicht eingerichtet.',
    );
  let origin: URL;
  try {
    origin = new URL(domain);
  } catch {
    throw new MailAuthorizationError('Die öffentliche HTTPS-Adresse fehlt.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !['', '/'].includes(origin.pathname)
  )
    throw new MailAuthorizationError('Die öffentliche HTTPS-Adresse ist ungültig.');
  return {
    tenantId: tenantId.toLowerCase(),
    clientId,
    clientSecret,
    callback: `${origin.origin}/api/agents/office/mail-assistant/callback`,
  };
}

/** Tokens are never returned to the browser, and every redemption is bound to one verified local user. */
export function createMailOAuth(config: MailOAuthConfig, deps: OAuthDependencies): MailOAuth {
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const inFlight = new Map<string, Promise<string>>();
  let indexes: Promise<void> | undefined;
  const ensureIndexes = () =>
    (indexes ??= deps
      .states()
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .then(() => undefined)
      .catch((error) => {
        indexes = undefined;
        throw error;
      }));
  const identity = async (ownerId: string): Promise<MailIdentity> => {
    const user = await deps.authorize(ownerId);
    if (user.id !== ownerId || !user.emailVerified || !user.email)
      throw new MailAuthorizationError(
        'Für die Postfachverbindung ist eine bestätigte persönliche E-Mail-Adresse erforderlich.',
      );
    return user;
  };
  const tokenRequest = async (values: Record<string, string>): Promise<TokenResponse> => {
    const response = await request(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...values,
      }),
    });
    if (!response.ok) throw new MailAuthorizationError();
    const tokens = (await response.json()) as TokenResponse;
    const scopes =
      tokens.scope
        ?.split(/\s+/)
        .filter(Boolean)
        .map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//, '')) ?? [];
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) ||
      Number(tokens.expires_in) < 60 ||
      !scopes.includes('Mail.ReadWrite') ||
      !scopes.includes('User.Read') ||
      scopes.some((scope) => !acceptedScopes.has(scope))
    )
      throw new MailAuthorizationError(
        'Microsoft hat nicht die ausschliesslich freigegebenen Postfachrechte bestätigt.',
      );
    return tokens;
  };
  const mailbox = async (
    accessToken: string,
    user: MailIdentity,
    expectedId?: string,
  ): Promise<GraphIdentity & { id: string }> => {
    const response = await request(
      'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName',
      {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok) throw new MailAuthorizationError();
    const profile = (await response.json()) as GraphIdentity;
    const email = user.email.trim().toLowerCase();
    if (
      !profile.id ||
      (expectedId && expectedId !== profile.id) ||
      ![profile.mail, profile.userPrincipalName].some(
        (value) => value?.trim().toLowerCase() === email,
      )
    )
      throw new MailAuthorizationError(
        'Das Microsoft-Konto muss zu deiner bestätigten Cowork-E-Mail-Adresse gehören.',
      );
    return { ...profile, id: profile.id };
  };
  const decode = async (record: MailCredential): Promise<TokenSet> => {
    if (record.tenantId !== config.tenantId || record.clientId !== config.clientId)
      throw new MailAuthorizationError();
    const value = deps.codec.open<TokenSet>(record._id, 'oauth-token', record.ciphertext);
    if (
      value.ownerId !== record._id ||
      value.tenantId !== config.tenantId ||
      value.mailboxId !== record.mailboxId ||
      !value.accessToken ||
      !value.refreshToken
    )
      throw new MailAuthorizationError();
    return value;
  };
  return {
    async start(ownerId: string): Promise<string> {
      const user = await identity(ownerId);
      await ensureIndexes();
      await deps.audit(ownerId, 'oauth.start');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const generation = randomUUID();
      const previous = await deps.credentials().findOne({ _id: ownerId });
      await deps.credentials().replaceOne(
        { _id: ownerId },
        {
          generation,
          tenantId: config.tenantId,
          clientId: config.clientId,
          mailboxId: previous?.mailboxId ?? '',
          email: user.email,
          ciphertext: '',
          expiresAt: new Date(0),
        },
        { upsert: true },
      );
      await deps.states().deleteMany({ ownerId });
      await deps.states().insertOne({
        _id: hash(state),
        ownerId,
        generation,
        ciphertext: deps.codec.seal(ownerId, 'oauth-state', {
          ownerId,
          verifier,
          clientId: config.clientId,
          tenantId: config.tenantId,
          callback: config.callback,
        }),
        expiresAt: new Date(now() + 10 * 60000),
      });
      try {
        await identity(ownerId);
      } catch {
        await deps.states().deleteMany({ ownerId, generation });
        await deps.credentials().deleteOne({ _id: ownerId, generation });
        throw new MailAuthorizationError();
      }
      const url = new URL(
        `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`,
      );
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: config.callback,
        scope: MAIL_ASSISTANT_SCOPES,
        state,
        code_challenge: hashBase64(verifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return url.toString();
    },
    async complete(state: string, code: string): Promise<void> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 8192)
        throw new MailAuthorizationError();
      const pending = await deps
        .states()
        .findOneAndDelete({ _id: hash(state), expiresAt: { $gt: new Date(now()) } });
      if (!pending)
        throw new MailAuthorizationError(
          'Die Anmeldung ist abgelaufen oder wurde bereits verwendet. Bitte erneut verbinden.',
        );
      const stored = deps.codec.open<{
        ownerId: string;
        verifier: string;
        clientId: string;
        tenantId: string;
        callback: string;
      }>(pending.ownerId, 'oauth-state', pending.ciphertext);
      if (
        stored.ownerId !== pending.ownerId ||
        stored.clientId !== config.clientId ||
        stored.tenantId !== config.tenantId ||
        stored.callback !== config.callback
      )
        throw new MailAuthorizationError();
      const user = await identity(pending.ownerId);
      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: stored.verifier,
        redirect_uri: config.callback,
        scope: MAIL_ASSISTANT_SCOPES,
      });
      const previous = await deps.credentials().findOne({ _id: pending.ownerId });
      if (!previous || previous.generation !== pending.generation)
        throw new MailAuthorizationError();
      const profile = await mailbox(tokens.access_token!, user, previous.mailboxId || undefined);
      await identity(pending.ownerId);
      await deps.audit(pending.ownerId, 'oauth.connect');
      const data: TokenSet = {
        ownerId: pending.ownerId,
        tenantId: config.tenantId,
        mailboxId: profile.id,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
      };
      const saved = await deps.credentials().replaceOne(
        { _id: pending.ownerId, generation: pending.generation },
        {
          generation: pending.generation,
          tenantId: config.tenantId,
          clientId: config.clientId,
          mailboxId: profile.id,
          email: user.email,
          ciphertext: deps.codec.seal(pending.ownerId, 'oauth-token', data),
          expiresAt: new Date(now() + Number(tokens.expires_in) * 1000),
        },
      );
      if (saved.modifiedCount !== 1) throw new MailAuthorizationError();
    },
    async status(ownerId: string) {
      const user = await identity(ownerId);
      const record = await deps
        .credentials()
        .findOne(
          { _id: ownerId },
          { projection: { _id: 1, tenantId: 1, clientId: 1, email: 1, expiresAt: 1 } },
        );
      return {
        connected: Boolean(
          record &&
            record.expiresAt.getTime() > 0 &&
            record.tenantId === config.tenantId &&
            record.clientId === config.clientId &&
            record.email.trim().toLowerCase() === user.email.trim().toLowerCase(),
        ),
        mailbox: record?.email ?? null,
      };
    },
    async disconnect(ownerId: string): Promise<void> {
      await identity(ownerId);
      await deps.audit(ownerId, 'oauth.disconnect');
      await deps.states().deleteMany({ ownerId });
      await deps.credentials().deleteOne({ _id: ownerId });
    },
    async token(ownerId: string): Promise<string> {
      const user = await identity(ownerId);
      const existing = await deps.credentials().findOne({ _id: ownerId });
      if (!existing || existing.email.toLowerCase() !== user.email.toLowerCase())
        throw new MailAuthorizationError();
      const tokens = await decode(existing);
      if (existing.expiresAt.getTime() > now() + 120000) return tokens.accessToken;
      const running = inFlight.get(ownerId);
      if (running) return running;
      const promise = (async () => {
        const record = await deps.credentials().findOneAndUpdate(
          {
            _id: ownerId,
            generation: existing.generation,
            $or: [{ refreshLease: { $exists: false } }, { refreshLease: { $lt: new Date(now()) } }],
          },
          { $set: { refreshLease: new Date(now() + 60000) } },
          { returnDocument: 'after' },
        );
        if (!record)
          throw new MailAuthorizationError(
            'Die Postfachverbindung wird gerade erneuert. Bitte kurz warten.',
          );
        try {
          const fresh = await tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: tokens.refreshToken,
            scope: MAIL_ASSISTANT_SCOPES,
          });
          await mailbox(fresh.access_token!, await identity(ownerId), existing.mailboxId);
          await deps.audit(ownerId, 'oauth.refresh');
          const result = await deps.credentials().updateOne(
            { _id: ownerId, generation: existing.generation },
            {
              $set: {
                ciphertext: deps.codec.seal(ownerId, 'oauth-token', {
                  ...tokens,
                  accessToken: fresh.access_token,
                  refreshToken: fresh.refresh_token,
                }),
                expiresAt: new Date(now() + Number(fresh.expires_in) * 1000),
              },
              $unset: { refreshLease: '' },
            },
          );
          if (result.modifiedCount !== 1) throw new MailAuthorizationError();
          return fresh.access_token!;
        } catch {
          await deps.credentials().deleteOne({ _id: ownerId, generation: existing.generation });
          throw new MailAuthorizationError();
        }
      })().finally(() => {
        inFlight.delete(ownerId);
      });
      inFlight.set(ownerId, promise);
      return promise;
    },
  };
}
function hashBase64(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
export interface MailOAuth {
  start(ownerId: string): Promise<string>;
  complete(state: string, code: string): Promise<void>;
  status(ownerId: string): Promise<{ connected: boolean; mailbox: string | null }>;
  disconnect(ownerId: string): Promise<void>;
  token(ownerId: string): Promise<string>;
}
