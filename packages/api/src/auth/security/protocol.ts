import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type FactorMethod = 'totp' | 'passkey' | 'recovery' | 'operator' | 'idp';
export interface Assurance {
  method: FactorMethod;
  verifiedAt: number;
  version: number;
}
export interface SecurityAccount {
  id: string;
  email: string;
  name?: string;
  role?: string;
  tenantId?: string;
  provider?: string;
  securityVersion?: number;
  securityEnrolled?: boolean;
  twoFactorEnabled?: boolean;
  totpSecret?: string;
  pendingTotpSecret?: string;
  pendingTotpExpires?: Date;
  backupCodes?: RecoveryRecord[];
  disabled?: boolean;
  disabledAt?: Date | null;
}
export interface RecoveryRecord {
  codeHash: string;
  used: boolean;
  usedAt: Date | null;
}
export interface SecurityConfig {
  required: boolean;
  activeSince: number;
  secret: string;
  rpID: string;
  rpName: string;
  origins: string[];
  storage?: { token: string; user: string };
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const opaque = (): string => randomBytes(32).toString('base64url');
export const versionOf = (user: SecurityAccount): number => user.securityVersion ?? 0;
export const requiredSecurity = (): boolean =>
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION === 'true';

export function resolveSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const client = new URL(env.DOMAIN_CLIENT || 'http://localhost:3080');
  const localPanel = ['localhost', '127.0.0.1'].includes(client.hostname)
    ? `${client.protocol}//${client.hostname}:${env.ADMIN_SIDECAR_PORT || '3010'}`
    : '';
  const origins = (
    env.PASSKEY_ORIGINS ||
    [client.origin, env.DOMAIN_SERVER, env.EUCOWORK_PANEL_URL || localPanel]
      .filter(Boolean)
      .join(',')
  )
    .split(',')
    .filter(Boolean)
    .map((value) => {
      const u = new URL(value.trim());
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== '/' ||
        (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname))
      )
        throw new Error('Ungültige Passkey-Anmeldeadresse.');
      return u.origin;
    });
  const rpID = env.PASSKEY_RP_ID || client.hostname;
  if (
    !origins.length ||
    origins.some((value) => {
      const h = new URL(value).hostname;
      return h !== rpID && !h.endsWith('.' + rpID);
    }) ||
    !/^[a-z0-9.-]+$/.test(rpID)
  )
    throw new Error('Passkey-Domain und Anmeldeadressen passen nicht zusammen.');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('Sitzungsschlüssel fehlt.');
  return {
    required: env.ENFORCE_TWO_FACTOR_AUTHENTICATION === 'true',
    activeSince: Number(env.MFA_POLICY_ACTIVE_SINCE) || 0,
    secret: env.JWT_SECRET,
    rpID,
    rpName: env.PASSKEY_RP_NAME || env.APP_TITLE || 'Kisuno',
    origins,
  };
}

export function validAssurance(
  value: Assurance | undefined,
  user: SecurityAccount,
  now: number = Date.now(),
): value is Assurance {
  return (
    !!value &&
    ['totp', 'passkey', 'recovery', 'operator', 'idp'].includes(value.method) &&
    Number.isSafeInteger(value.verifiedAt) &&
    value.verifiedAt <= now + 5000 &&
    value.verifiedAt > now - 7 * 86400_000 &&
    value.version === versionOf(user)
  );
}

export function accessAllowed(
  payload: { iat?: number; exp?: number; mfa?: Assurance; tokenPurpose?: string },
  user: SecurityAccount,
  required: boolean,
  activeSince: number,
  now: number = Date.now(),
): boolean {
  if (payload.tokenPurpose || user.disabled || user.disabledAt) return false;
  if (!required) return true;
  if (validAssurance(payload.mfa, user, now)) return true;
  return (
    versionOf(user) === 0 &&
    typeof payload.iat === 'number' &&
    payload.iat < activeSince &&
    activeSince > 0 &&
    now / 1000 < Math.min(payload.exp ?? 0, activeSince + 900)
  );
}

export function securityToken(
  config: SecurityConfig,
  user: SecurityAccount,
  nonce: string,
  setup: boolean,
): string {
  return jwt.sign(
    {
      userId: user.id,
      version: versionOf(user),
      nonce,
      tokenPurpose: setup ? 'mfa-setup' : 'mfa-login',
    },
    config.secret,
    { algorithm: 'HS256', audience: 'kisuno-security', expiresIn: '5m' },
  );
}

export interface PendingToken {
  userId: string;
  version: number;
  nonce: string;
  tokenPurpose: string;
}
export function verifySecurityToken(value: string, config: SecurityConfig): PendingToken | null {
  try {
    const p = jwt.verify(value, config.secret, {
      algorithms: ['HS256'],
      audience: 'kisuno-security',
    });
    if (
      typeof p === 'string' ||
      typeof p.userId !== 'string' ||
      typeof p.nonce !== 'string' ||
      !Number.isSafeInteger(p.version) ||
      !['mfa-setup', 'mfa-login'].includes(p.tokenPurpose)
    )
      return null;
    return { userId: p.userId, version: p.version, nonce: p.nonce, tokenPurpose: p.tokenPurpose };
  } catch {
    return null;
  }
}

export function recoveryCodes(): { plain: string[]; records: RecoveryRecord[] } {
  const plain = Array.from({ length: 10 }, () =>
    randomBytes(16).toString('hex').match(/.{8}/g)!.join('-'),
  );
  return {
    plain,
    records: plain.map((code) => ({ codeHash: recoveryHash(code), used: false, usedAt: null })),
  };
}
export function recoveryHash(code: string): string {
  return digest(code.trim().replace(/-/g, '').toLowerCase());
}

/** RFC 6238, matching LibreChat's native six-digit, SHA-1, 30-second TOTP. */
export function nativeTotp(secret: string, now: number = Date.now()): string {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    if (n < 0) throw new Error('Ungültiges Authenticator-Geheimnis.');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function verifyNativeTotp(secret: string, code: string): boolean {
  return matchingTotpStep(secret, code) !== null;
}
export function matchingTotpStep(secret: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const candidate = Buffer.from(code);
  const now = Date.now();
  for (const offset of [-1, 0, 1])
    if (timingSafeEqual(candidate, Buffer.from(nativeTotp(secret, now + offset * 30_000))))
      return Math.floor(now / 30_000) + offset;
  return null;
}
export function newTotpSecret(): string {
  let bits = 0,
    value = 0,
    out = '';
  for (const b of randomBytes(20)) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Machine provisioning never creates a human MFA session and is path-scoped. */
export function automationAllowed(
  payload: jwt.JwtPayload | undefined,
  user: SecurityAccount,
  path: string,
  method: string,
  now: number = Date.now(),
): boolean {
  if (
    !payload ||
    payload.tokenPurpose !== 'admin-automation' ||
    payload.aud !== 'kisuno-admin-automation' ||
    user.role !== 'ADMIN' ||
    user.disabled ||
    user.disabledAt ||
    payload.securityVersion !== versionOf(user)
  )
    return false;
  if (
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    payload.exp - payload.iat > 60 ||
    payload.iat > now / 1000 + 5 ||
    payload.exp <= now / 1000
  )
    return false;
  const route = path.split('?')[0];
  return (
    (method === 'GET' &&
      ['/api/admin/config/base', '/api/admin/config/role/__base__'].includes(route)) ||
    (method === 'PATCH' &&
      /^\/api\/admin\/(config\/role\/__base__\/fields|roles\/(USER|ADMIN)\/permissions)$/.test(
        route,
      ))
  );
}
