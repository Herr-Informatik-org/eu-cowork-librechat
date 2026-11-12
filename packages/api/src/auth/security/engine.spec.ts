import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { SecurityStore, Credential } from './engine';
import type { Assurance, SecurityAccount, SecurityConfig } from './protocol';
import { createSecurityEngine } from './engine';
import { nativeTotp, newTotpSecret, verifyNativeTotp } from './protocol';

function harness() {
  let user: SecurityAccount = {
    id: '012345678901234567890123',
    email: 'test@example.invalid',
    provider: 'local',
    role: 'ADMIN',
    securityVersion: 0,
  };
  const cache = new Map<string, string>(),
    keys: Credential[] = [],
    rates = new Map<string, number>();
  let locked = false;
  const store: SecurityStore = {
    account: async (id) =>
      id === user.id ? { ...user, backupCodes: user.backupCodes?.map((c) => ({ ...c })) } : null,
    update: async (id, version, fields) => {
      if (id !== user.id || version !== (user.securityVersion ?? 0)) throw Error('version');
      user = { ...user, ...fields };
      return { ...user };
    },
    get: async (k) => cache.get(k),
    set: async (k, v) => {
      cache.set(k, v);
    },
    delete: async (k) => cache.delete(k),
    getDel: async (k) => {
      const v = cache.get(k);
      cache.delete(k);
      return v;
    },
    credentials: async (id) => keys.filter((k) => k.userId === id),
    credential: async (id) => keys.find((k) => k.credentialId === id) || null,
    addCredential: async (c) => {
      keys.push(c);
    },
    removeCredential: async (id) => {
      const i = keys.findIndex((k) => k.credentialId === id);
      if (i >= 0) keys.splice(i, 1);
    },
    recordUse: async () => true,
    claimTotp: async (id, secretHash, step) => {
      const k = id + secretHash + step;
      if (cache.has(k)) return false;
      cache.set(k, 'used');
      return true;
    },
    consumeRecovery: async (id, hash) => {
      const row = user.backupCodes?.find((c) => c.codeHash === hash && !c.used);
      if (!row || id !== user.id) return false;
      row.used = true;
      return true;
    },
    rate: async (k, max) => {
      const n = (rates.get(k) || 0) + 1;
      rates.set(k, n);
      return n <= max;
    },
    withLock: async (_id, fn) => {
      if (locked) throw Object.assign(Error('locked'), { status: 409 });
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
  };
  const config: SecurityConfig = {
    required: true,
    activeSince: 1,
    secret: 's'.repeat(48),
    rpID: 'localhost',
    rpName: 'Test',
    origins: ['http://localhost:3080'],
  };
  const issue = jest.fn(async (u: SecurityAccount, proof: Assurance) => ({
    token: jwt.sign({ id: u.id, mfa: proof }, config.secret, { expiresIn: '15m' }),
    user: { id: u.id, email: u.email },
  }));
  const engine = createSecurityEngine({
    config,
    store,
    encrypt: (s) => 'encrypted:' + s,
    decrypt: (s) => s.replace(/^encrypted:/, ''),
    secret: newTotpSecret,
    verifyTotp: verifyNativeTotp,
    admin: async (u) => u.role === 'ADMIN',
    issue,
  });
  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', async (req, res) => {
    await engine.begin(user, req, res);
  });
  app.use('/api/auth/security', engine.router);
  const post = (path: string, body: object, token?: string) =>
    request(app)
      .post('/api/auth/security/' + path)
      .set('Origin', config.origins[0])
      .set(token ? { Authorization: 'Bearer ' + token } : {})
      .send(body);
  const begin = async () => (await request(app).post('/api/auth/login').send({})).body;
  const setup = async () => {
    const start = await begin();
    const secret = (await post('totp/start', { tempToken: start.tempToken })).body.secret;
    const result = await post('totp/confirm', {
      tempToken: start.tempToken,
      token: nativeTotp(secret),
    });
    return { start, secret, result };
  };
  return {
    app,
    post,
    begin,
    setup,
    issue,
    store,
    getUser: () => user,
    setUser: (u: Partial<SecurityAccount>) => {
      user = { ...user, ...u };
    },
  };
}

describe('required MFA engine', () => {
  it('issues only a restricted setup credential before enrollment', async () => {
    const h = harness(),
      r = await h.begin();
    expect(r.setupRequired).toBe(true);
    expect(r.token).toBeUndefined();
    expect(h.issue).not.toHaveBeenCalled();
    expect((await h.post('status', { tempToken: r.tempToken })).status).toBe(200);
    expect((await h.post('recovery/regenerate', { tempToken: r.tempToken })).status).not.toBe(200);
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.getUser().securityVersion).toBe(0);
  });
  it('requires a valid current OTP, then retires the enrollment flow', async () => {
    const h = harness(),
      s = await h.setup();
    expect(s.result.status).toBe(200);
    expect(s.result.body.backupCodes).toHaveLength(10);
    expect(h.getUser().twoFactorEnabled).toBe(true);
    expect(h.getUser().securityVersion).toBe(1);
    expect(
      (await h.post('totp/confirm', { tempToken: s.start.tempToken, token: nativeTotp(s.secret) }))
        .status,
    ).toBe(401);
    expect(h.issue).toHaveBeenCalledTimes(1);
  });
  it('does not let a password-only challenge replace an enrolled factor', async () => {
    const h = harness();
    await h.setup();
    const pending = await h.begin();
    expect(pending.setupRequired).toBe(false);
    expect((await h.post('totp/start', { tempToken: pending.tempToken })).status).toBe(401);
    expect(
      (await h.post('passkeys/register/options', { tempToken: pending.tempToken })).status,
    ).toBe(401);
  });
  it('consumes a recovery code atomically across two challenges', async () => {
    const h = harness(),
      s = await h.setup(),
      a = await h.begin(),
      b = await h.begin();
    const results = await Promise.all(
      [a, b].map((flow) =>
        h.post('verify', { tempToken: flow.tempToken, backupCode: s.result.body.backupCodes[0] }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(h.getUser().backupCodes?.filter((c) => c.used)).toHaveLength(1);
  });
  it('does not expose secrets or recovery hashes through status', async () => {
    const h = harness(),
      s = await h.setup();
    const r = await h.post('status', {}, s.result.body.token);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(s.secret);
    expect(JSON.stringify(r.body)).not.toContain('codeHash');
  });
  it('rejects old sessions after factor state changes and stale management proof', async () => {
    const h = harness(),
      s = await h.setup();
    h.setUser({ securityVersion: 2 });
    expect((await h.post('status', {}, s.result.body.token)).status).toBe(401);
    h.setUser({ securityVersion: 1 });
    const proof = { method: 'totp', verifiedAt: Date.now() - 600000, version: 1 };
    const token = jwt.sign({ id: h.getUser().id, mfa: proof }, 's'.repeat(48));
    expect((await h.post('recovery/regenerate', {}, token)).status).toBe(401);
  });
  it('rejects unknown origins before any security work', async () => {
    const h = harness(),
      r = await request(h.app)
        .post('/api/auth/security/passkeys/options')
        .set('Origin', 'https://attacker.invalid')
        .send({});
    expect(r.status).toBe(403);
    expect(h.issue).not.toHaveBeenCalled();
  });
  it('does not remove the only authenticator and rejects a just-used TOTP', async () => {
    const h = harness(),
      setup = await h.setup(),
      flow = await h.begin();
    expect((await h.post('totp/remove', {}, setup.result.body.token)).status).toBe(409);
    expect(
      (await h.post('verify', { tempToken: flow.tempToken, token: nativeTotp(setup.secret) }))
        .status,
    ).toBe(401);
    expect(h.getUser().twoFactorEnabled).toBe(true);
  });
  it('limits attempts across challenges and counts successful admissions', async () => {
    const h = harness();
    const s = await h.setup();
    const flow = await h.begin();
    for (let i = 0; i < 8; i++)
      await h.post('verify', { tempToken: flow.tempToken, token: 'not-a-code' });
    expect(
      (await h.post('verify', { tempToken: flow.tempToken, token: nativeTotp(s.secret) })).status,
    ).toBe(429);
  });
});
