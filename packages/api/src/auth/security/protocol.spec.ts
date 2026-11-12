import jwt from 'jsonwebtoken';
import {
  accessAllowed,
  automationAllowed,
  nativeTotp,
  recoveryCodes,
  recoveryHash,
  resolveSecurityConfig,
  securityToken,
  verifyNativeTotp,
  verifySecurityToken,
} from './protocol';
import type { SecurityAccount, SecurityConfig } from './protocol';

const user: SecurityAccount = {
  id: '012345678901234567890123',
  email: 'test@example.invalid',
  securityVersion: 2,
};
const config: SecurityConfig = {
  required: true,
  activeSince: 1,
  secret: 's'.repeat(48),
  rpID: 'localhost',
  rpName: 'Test',
  origins: ['http://localhost:3080'],
};
describe('machine provisioning credentials', () => {
  it('allows only bounded configuration automation and never chat or login', () => {
    const now = Date.now(),
      iat = Math.floor(now / 1000);
    const payload = {
      tokenPurpose: 'admin-automation',
      aud: 'kisuno-admin-automation',
      iat,
      exp: iat + 60,
      securityVersion: 2,
    };
    const admin = { ...user, role: 'ADMIN' };
    expect(automationAllowed(payload, admin, '/api/admin/config/base', 'GET', now)).toBe(true);
    expect(
      automationAllowed(payload, admin, '/api/admin/config/role/__base__/fields', 'PATCH', now),
    ).toBe(true);
    for (const path of [
      '/api/user',
      '/api/agents/chat',
      '/api/admin/users',
      '/api/auth/security/page',
    ])
      expect(automationAllowed(payload, admin, path, 'GET', now)).toBe(false);
    expect(
      automationAllowed(
        { ...payload, exp: iat + 900 },
        admin,
        '/api/admin/config/base',
        'GET',
        now,
      ),
    ).toBe(false);
    expect(
      automationAllowed(
        payload,
        { ...admin, securityVersion: 3 },
        '/api/admin/config/base',
        'GET',
        now,
      ),
    ).toBe(false);
    expect(accessAllowed(payload, admin, false, 0)).toBe(false);
  });
});

describe('security protocol', () => {
  it('keeps the standard local chat and admin installation usable without extra origin configuration', () => {
    const local = resolveSecurityConfig({
      JWT_SECRET: 's'.repeat(48),
      ENFORCE_TWO_FACTOR_AUTHENTICATION: 'true',
    });
    expect(local.origins).toEqual(['http://localhost:3080', 'http://localhost:3010']);
    expect(local.rpID).toBe('localhost');
  });
  it('separates setup, login challenge and full bearer credentials', () => {
    const token = securityToken(config, user, 'nonce', true);
    expect(verifySecurityToken(token, config)?.tokenPurpose).toBe('mfa-setup');
    const decoded = jwt.verify(token, config.secret) as jwt.JwtPayload;
    expect(decoded.id).toBeUndefined();
    expect(accessAllowed(decoded, user, true, 1)).toBe(false);
    expect(verifySecurityToken(jwt.sign({ id: user.id }, config.secret), config)).toBeNull();
    expect(verifySecurityToken(token, { ...config, secret: 'other'.repeat(12) })).toBeNull();
  });
  it('rejects expired challenges and unexpected token purposes', () => {
    const token = jwt.sign(
      { userId: user.id, nonce: 'n', version: 2, tokenPurpose: 'mfa-login' },
      config.secret,
      { audience: 'kisuno-security', expiresIn: -1 },
    );
    expect(verifySecurityToken(token, config)).toBeNull();
    expect(
      verifySecurityToken(
        jwt.sign(
          { userId: user.id, nonce: 'n', version: 2, tokenPurpose: 'access' },
          config.secret,
          { audience: 'kisuno-security' },
        ),
        config,
      ),
    ).toBeNull();
  });
  it('keeps legacy access only in the bounded transition and never after factor changes', () => {
    const current = { ...user, securityVersion: 0 };
    const since = Date.now() / 1000 - 10;
    expect(accessAllowed({ iat: since - 1, exp: since + 3600 }, current, true, since)).toBe(true);
    expect(accessAllowed({ iat: since + 1, exp: since + 3600 }, current, true, since)).toBe(false);
    expect(
      accessAllowed(
        { iat: since - 1, exp: since + 3600 },
        current,
        true,
        since,
        (since + 901) * 1000,
      ),
    ).toBe(false);
    expect(accessAllowed({ iat: since - 1, exp: since + 3600 }, user, true, since)).toBe(false);
  });
  it('rejects stale, future or version-mismatched assurance', () => {
    const proof = { method: 'passkey' as const, verifiedAt: Date.now(), version: 2 };
    expect(accessAllowed({ mfa: proof }, user, true, 1)).toBe(true);
    for (const mfa of [
      { ...proof, version: 1 },
      { ...proof, verifiedAt: Date.now() + 60000 },
      { ...proof, verifiedAt: Date.now() - 8 * 86400000 },
    ])
      expect(accessAllowed({ mfa }, user, true, 1)).toBe(false);
  });
  it('matches RFC 6238 vectors and rejects malformed OTPs', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(nativeTotp(secret, 59000)).toBe('287082');
    expect(nativeTotp(secret, 1111111109000)).toBe('081804');
    expect(verifyNativeTotp(secret, nativeTotp(secret))).toBe(true);
    expect(verifyNativeTotp(secret, '0000000')).toBe(false);
    expect(verifyNativeTotp(secret, '１２３４５６')).toBe(false);
  });
  it('issues independent 128-bit recovery codes without storing their plaintext', () => {
    const codes = recoveryCodes();
    expect(codes.plain).toHaveLength(10);
    expect(new Set(codes.plain).size).toBe(10);
    expect(codes.plain.every((c) => /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(c))).toBe(true);
    expect(codes.records[0].codeHash).toBe(recoveryHash(codes.plain[0].toUpperCase()));
    expect(JSON.stringify(codes.records)).not.toContain(codes.plain[0]);
    expect(recoveryHash('1234abcd')).toBe(
      '221b37fcdb52d0f7c39bbd0be211db0e1c00ca5fbecd5788780463026c6b964b',
    );
  });
  it('pins exact HTTPS origins and rejects sibling-domain and path confusion', () => {
    const env = {
      JWT_SECRET: config.secret,
      DOMAIN_CLIENT: 'https://chat.example.invalid',
      PASSKEY_ORIGINS: 'https://chat.example.invalid,https://admin.chat.example.invalid',
      ENFORCE_TWO_FACTOR_AUTHENTICATION: 'true',
    };
    expect(resolveSecurityConfig(env).rpID).toBe('chat.example.invalid');
    for (const origins of [
      'https://evilchat.example.invalid',
      'https://chat.example.invalid/path',
      'https://chat.example.invalid@attacker.invalid',
      'http://chat.example.invalid',
    ])
      expect(() => resolveSecurityConfig({ ...env, PASSKEY_ORIGINS: origins })).toThrow();
  });
});
