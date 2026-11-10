import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { OpsPersonalStore } from './store';
import type { ServerRequest } from '~/types';
import type {
  OpsAuthorization,
  OpsPersonalContext,
  OpsPersonalContextOptions,
  OpsPersonalGrant,
  OpsPersonalNative,
  OpsPersonalScope,
  OpsPersonalTokens,
} from './types';

export const OPS_PERSONAL_ISSUER = 'https://cowork.herr-informatik.ch';
export const OPS_PERSONAL_REDIRECT = 'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SAFE_STATE = /^[A-Za-z0-9_-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const SCOPES: OpsPersonalScope[] = ['mail:compose', 'skills:use', 'brain:read', 'mail:background'];
export class OpsPersonalError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super('Die persönliche OPS-Verbindung ist nicht verfügbar oder nicht erlaubt.');
  }
}
function fail(status = 401, code = 'invalid_grant'): never {
  throw new OpsPersonalError(status, code);
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function requireOpsPersonalEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.KISUNO_OPS_INTERNAL_ENABLED !== 'true' || env.KISUNO_OPS_TENANT_ID !== 'cwv01')
    fail(404, 'not_found');
}
export function parseOpsAuthorization(input: Partial<OpsAuthorization>): OpsAuthorization {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        ![
          'response_type',
          'client_id',
          'redirect_uri',
          'state',
          'code_challenge',
          'code_challenge_method',
          'ops_user_id',
          'scope',
        ].includes(key),
    ) ||
    input.response_type !== 'code' ||
    input.client_id !== 'ops' ||
    input.redirect_uri !== OPS_PERSONAL_REDIRECT ||
    input.code_challenge_method !== 'S256' ||
    typeof input.state !== 'string' ||
    !SAFE_STATE.test(input.state) ||
    typeof input.code_challenge !== 'string' ||
    !CHALLENGE.test(input.code_challenge) ||
    typeof input.ops_user_id !== 'string' ||
    !UUID.test(input.ops_user_id)
  )
    fail(400, 'invalid_request');
  requestedOpsScopes(input.scope);
  return input as OpsAuthorization;
}
export function requestedOpsScopes(value?: string): OpsPersonalScope[] {
  if (value !== undefined && (typeof value !== 'string' || value.length > 128))
    fail(400, 'invalid_scope');
  const requested = value === undefined ? ['mail:compose', 'skills:use'] : value.split(' ');
  if (
    new Set(requested).size !== requested.length ||
    !requested.includes('mail:compose') ||
    !requested.includes('skills:use') ||
    !requested.every((scope) => SCOPES.includes(scope as OpsPersonalScope))
  )
    fail(400, 'invalid_scope');
  return requested as OpsPersonalScope[];
}
function token(kind: 'a' | 'r' | 'c', id: string): string {
  return `kops${kind}_${id}.${randomBytes(32).toString('base64url')}`;
}
function tokenId(value: string, kind: 'a' | 'r' | 'c'): string {
  if (typeof value !== 'string') return fail();
  const found = new RegExp(`^kops${kind}_([a-f0-9]{32})\\.([A-Za-z0-9_-]{43})$`).exec(value);
  return found?.[1] ?? fail();
}
export class OpsPersonalService {
  constructor(
    readonly store: OpsPersonalStore,
    readonly native: OpsPersonalNative,
    readonly now: () => number = Date.now,
    readonly enabled: () => void = requireOpsPersonalEnabled,
  ) {}

  async user(ownerId: string): Promise<IUser> {
    this.enabled();
    const user = await this.native.currentUser(ownerId);
    if (
      !user ||
      String(user.id ?? user._id) !== ownerId ||
      !user.role ||
      user.emailVerified !== true ||
      user.tenantId != null ||
      (user.expiresAt != null &&
        (!Number.isFinite(new Date(user.expiresAt).getTime()) ||
          new Date(user.expiresAt).getTime() <= this.now()))
    )
      fail(401, 'inactive_user');
    return user;
  }

  private async grantUser(grant: OpsPersonalGrant): Promise<IUser> {
    const user = await this.user(grant.ownerId);
    if ((user.tenantId ?? null) !== grant.ownerTenantId) fail(401, 'inactive_user');
    return user;
  }

  async authorize(
    ownerId: string,
    request: OpsAuthorization,
    scopes: OpsPersonalScope[],
  ): Promise<{ redirect_uri: string }> {
    this.enabled();
    const input = parseOpsAuthorization(request);
    const user = await this.user(ownerId);
    const requested = requestedOpsScopes(input.scope);
    if (
      !Array.isArray(scopes) ||
      !scopes.includes('mail:compose') ||
      !scopes.includes('skills:use') ||
      new Set(scopes).size !== scopes.length ||
      !scopes.every((scope) => requested.includes(scope))
    )
      fail(400, 'invalid_scope');
    if (!(await this.native.skillsAllowed(user))) fail(403, 'skills_forbidden');
    if (scopes.includes('brain:read')) {
      const config = await this.native.config(user);
      if (!(await this.native.brainAllowed({ user, config } as ServerRequest)))
        fail(403, 'brain_forbidden');
    }
    const now = this.now();
    const id = randomUUID().replaceAll('-', '');
    const code = token('c', id);
    await this.store.create({
      _id: id,
      ownerId,
      ownerTenantId: user.tenantId ?? null,
      opsUserId: input.ops_user_id,
      scopes,
      status: 'pending',
      createdAt: new Date(now),
      expiresAt: new Date(now + 30 * 86400_000),
      codeHash: digest(code),
      codeChallenge: input.code_challenge,
      codeExpiresAt: new Date(now + 300_000),
      accessHash: '',
      accessExpiresAt: new Date(0),
      refreshHash: '',
      usedRefreshHashes: [],
    });
    const redirect = new URL(OPS_PERSONAL_REDIRECT);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', input.state);
    return { redirect_uri: redirect.href };
  }

  private tokens(grant: OpsPersonalGrant): {
    response: OpsPersonalTokens;
    accessHash: string;
    refreshHash: string;
    accessExpiresAt: Date;
  } {
    const access = token('a', grant._id);
    const refresh = token('r', grant._id);
    const expires = Math.min(600, Math.floor((grant.expiresAt.getTime() - this.now()) / 1000));
    if (expires <= 0) fail();
    const response: OpsPersonalTokens = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expires,
      refresh_token: refresh,
      refresh_expires_in: Math.floor((grant.expiresAt.getTime() - this.now()) / 1000),
      scope: grant.scopes.join(' '),
      tenant_id: 'cwv01',
      grant_id: grant._id,
      subject: grant.ownerId,
      ops_user_id: grant.opsUserId,
    };
    return {
      response,
      accessHash: digest(access),
      refreshHash: digest(refresh),
      accessExpiresAt: new Date(this.now() + expires * 1000),
    };
  }

  async exchange(
    code: string,
    verifier: string,
    redirect: string,
    opsUserId: string,
  ): Promise<OpsPersonalTokens> {
    this.enabled();
    const grant = await this.store.get(tokenId(code, 'c'));
    if (
      !grant ||
      grant.status !== 'pending' ||
      grant.opsUserId !== opsUserId ||
      redirect !== OPS_PERSONAL_REDIRECT ||
      typeof verifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !equal(grant.codeHash, digest(code)) ||
      !equal(grant.codeChallenge, createHash('sha256').update(verifier).digest('base64url')) ||
      grant.codeExpiresAt.getTime() <= this.now() ||
      grant.expiresAt.getTime() <= this.now()
    )
      fail();
    await this.grantUser(grant);
    const next = this.tokens(grant);
    if (
      !(await this.store.activate(
        grant._id,
        grant.codeHash,
        new Date(this.now()),
        next.accessHash,
        next.accessExpiresAt,
        next.refreshHash,
      ))
    )
      fail();
    return next.response;
  }

  async refresh(value: string, opsUserId: string): Promise<OpsPersonalTokens> {
    this.enabled();
    const grant = await this.store.get(tokenId(value, 'r'));
    const hash = digest(value);
    if (
      !grant ||
      grant.opsUserId !== opsUserId ||
      grant.status !== 'active' ||
      grant.expiresAt.getTime() <= this.now()
    )
      fail();
    if (grant.usedRefreshHashes.includes(hash)) {
      await this.store.revoke(grant._id, new Date(this.now()));
      fail();
    }
    if (!equal(grant.refreshHash, hash)) fail();
    await this.grantUser(grant);
    const next = this.tokens(grant);
    if (
      !(await this.store.rotate(
        grant._id,
        hash,
        new Date(this.now()),
        next.accessHash,
        next.accessExpiresAt,
        next.refreshHash,
      ))
    ) {
      const current = await this.store.get(grant._id);
      if (current?.usedRefreshHashes.includes(hash))
        await this.store.revoke(grant._id, new Date(this.now()));
      fail();
    }
    return next.response;
  }

  async access(
    value: string,
    opsUserId: string,
    scopes: OpsPersonalScope[] = [],
  ): Promise<{ grant: OpsPersonalGrant; user: IUser }> {
    this.enabled();
    const grant = await this.store.get(tokenId(value, 'a'));
    if (
      !grant ||
      grant.status !== 'active' ||
      grant.opsUserId !== opsUserId ||
      !equal(grant.accessHash, digest(value)) ||
      grant.accessExpiresAt.getTime() <= this.now() ||
      grant.expiresAt.getTime() <= this.now()
    )
      fail();
    if (!scopes.every((scope) => grant.scopes.includes(scope))) fail(403, 'insufficient_scope');
    const user = await this.grantUser(grant);
    return { grant, user };
  }

  async revoke(value: string, opsUserId: string): Promise<void> {
    this.enabled();
    if (typeof value !== 'string' || !/^kops[ar]_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(value))
      return;
    const kind = typeof value === 'string' && value.startsWith('kopsr_') ? 'r' : 'a';
    const grant = await this.store.get(tokenId(value, kind));
    if (!grant || grant.opsUserId !== opsUserId) return;
    const hash = digest(value);
    if (
      equal(grant.accessHash, hash) ||
      equal(grant.refreshHash, hash) ||
      grant.usedRefreshHashes.includes(hash)
    )
      await this.store.revoke(grant._id, new Date(this.now()));
  }

  credentials(req: Request): { value: string; opsUserId: string } {
    const authorization = req.headers.authorization;
    const opsUserId = req.headers['x-ops-user-id'];
    if (
      !authorization?.startsWith('Bearer ') ||
      typeof opsUserId !== 'string' ||
      !UUID.test(opsUserId)
    )
      return fail();
    return { value: authorization.slice(7), opsUserId };
  }

  async skills(req: Request): Promise<{ skills: OpsPersonalContext['sourcesUsed']['skills'] }> {
    const { value, opsUserId } = this.credentials(req);
    const { user } = await this.access(value, opsUserId, ['skills:use']);
    if (!(await this.native.skillsAllowed(user))) fail(403, 'skills_forbidden');
    const ids = (await this.native.skillIds(user)).slice(0, 200);
    const skills = await Promise.all(ids.map((id) => this.native.skill(id)));
    const fresh = await this.access(value, opsUserId, ['skills:use']);
    if (!(await this.native.skillsAllowed(fresh.user))) fail(403, 'skills_forbidden');
    const allowed = new Set(await this.native.skillIds(fresh.user));
    return {
      skills: skills
        .filter(
          (skill) =>
            skill &&
            allowed.has(skill.id) &&
            skill.userInvocable !== false &&
            (fresh.user.skillStates instanceof Map
              ? fresh.user.skillStates.get(skill.id)
              : fresh.user.skillStates?.[skill.id]) !== false,
        )
        .map((skill) => ({ id: skill!.id, name: skill!.name, version: skill!.version })),
    };
  }

  async context(req: Request, options: OpsPersonalContextOptions): Promise<OpsPersonalContext> {
    const { value, opsUserId } = this.credentials(req);
    if (
      typeof options.input !== 'string' ||
      !options.input.trim() ||
      Buffer.byteLength(options.input) > 40_000 ||
      options.input.includes('\0') ||
      !Array.isArray(options.skillIds) ||
      options.skillIds.length > 8 ||
      new Set(options.skillIds).size !== options.skillIds.length ||
      options.skillIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) ||
      typeof options.brain !== 'boolean' ||
      (options.background !== undefined && typeof options.background !== 'boolean')
    )
      fail(400, 'invalid_request');
    const scopes: OpsPersonalScope[] = [
      'mail:compose',
      ...(options.skillIds.length ? ['skills:use' as const] : []),
      ...(options.brain ? ['brain:read' as const] : []),
      ...(options.background ? ['mail:background' as const] : []),
    ];
    const { grant, user } = await this.access(value, opsUserId, scopes);
    if (!(await this.native.skillsAllowed(user))) fail(403, 'skills_forbidden');
    const config = await this.native.config(user);
    const nativeReq = Object.assign(Object.create(req), { user, config }) as ServerRequest;
    const blocks: string[] = [];
    const used: OpsPersonalContext['sourcesUsed'] = { skills: [], brain: false };
    if (options.skillIds.length) {
      if (!(await this.native.skillsAllowed(user))) fail(403, 'skills_forbidden');
      const allowed = new Set(await this.native.skillIds(user));
      if (options.skillIds.some((id) => !allowed.has(id))) fail(403, 'skill_forbidden');
      for (const id of options.skillIds) {
        options.signal?.throwIfAborted();
        const skill = await this.native.skill(id);
        if (!skill || skill.userInvocable === false || Buffer.byteLength(skill.body) > 16_000)
          fail(403, 'skill_forbidden');
        const states = user.skillStates;
        if (states && (states instanceof Map ? states.get(id) : states[id]) === false)
          fail(403, 'skill_inactive');
        blocks.push(
          JSON.stringify({ kind: 'selected_skill', name: skill.name, instructions: skill.body }),
        );
        used.skills.push({ id, name: skill.name, version: skill.version });
      }
    }
    if (options.brain) {
      if (!(await this.native.brainAllowed(nativeReq))) fail(403, 'brain_forbidden');
      const sender = options.sender;
      if (
        sender !== undefined &&
        (typeof sender !== 'string' ||
          sender.length > 254 ||
          !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender))
      )
        fail(400, 'invalid_request');
      const memory = await this.native.mailContext(nativeReq, {
        query: options.input,
        sender,
        contextBudgetTokens: 1800,
        signal: options.signal,
      });
      if (memory.status === 'unavailable') fail(503, 'brain_unavailable');
      if (memory.context) {
        blocks.push(JSON.stringify({ kind: 'personal_mail_context', evidence: memory.context }));
        used.brain = true;
      }
    }
    const contextText = blocks.join('\n');
    if (Buffer.byteLength(contextText) > 40_000) fail(413, 'context_too_large');
    options.signal?.throwIfAborted();
    const assertActive = async () => {
      const fresh = await this.access(value, opsUserId, scopes);
      if (!(await this.native.skillsAllowed(fresh.user))) fail(403, 'skills_forbidden');
      if (options.skillIds.length) {
        if (!(await this.native.skillsAllowed(fresh.user))) fail(403, 'skills_forbidden');
        const allowed = new Set(await this.native.skillIds(fresh.user));
        for (const selected of used.skills) {
          const skill = await this.native.skill(selected.id);
          const states = fresh.user.skillStates;
          const active = states instanceof Map ? states.get(selected.id) : states?.[selected.id];
          if (
            !allowed.has(selected.id) ||
            !skill ||
            skill.version !== selected.version ||
            skill.userInvocable === false ||
            active === false
          )
            fail(403, 'skill_forbidden');
        }
      }
      if (
        options.brain &&
        !(await this.native.brainAllowed(
          Object.assign(Object.create(req), {
            user: fresh.user,
            config: await this.native.config(fresh.user),
          }) as ServerRequest,
        ))
      )
        fail(403, 'brain_forbidden');
    };
    await assertActive();
    return {
      contextText,
      ownerId: grant.ownerId,
      subject: grant.ownerId,
      grantId: grant._id,
      sourcesUsed: used,
      user,
      config,
      assertActive,
    };
  }
}
let configured: OpsPersonalService | undefined;
export function configureOpsPersonal(service: OpsPersonalService): void {
  configured = service;
}
export function getOpsPersonalService(): OpsPersonalService {
  requireOpsPersonalEnabled();
  return configured ?? fail(503, 'unconfigured');
}
export function resolveOpsPersonalContext(
  req: Request,
  options: OpsPersonalContextOptions,
): Promise<OpsPersonalContext> {
  return getOpsPersonalService().context(req, options);
}
