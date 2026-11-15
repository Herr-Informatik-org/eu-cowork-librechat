import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { outlookRegistrationScript } from './registration';

type Grant = {
  id: string;
  clientId: string;
  resourceId: string;
  consentType: string;
  principalId: string | null;
  scope: string;
};
type Fixture = {
  grants: Grant[];
  globalConsent?: boolean;
  concurrentChange?: boolean;
  cleanupFailure?: boolean;
  creationFailure?: boolean;
  switchTenant?: boolean;
  ambiguousBaseline?: boolean;
  evilNext?: boolean;
  snapshotDelay?: number;
};
type State = {
  succeeded: boolean;
  failure: string;
  grants: Grant[];
  writes: { method: string; path: string; body: { scope?: string } }[];
  connects: string[][];
  disconnected: number;
  sessionEnded: boolean;
};
const client = '77777777-7777-4777-8777-777777777777';
const resource = '99999999-9999-4999-8999-999999999999';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const setup = ['Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All'];
const grant = (scope: string, patch: Partial<Grant> = {}): Grant => ({
  id: 'existing-own-grant',
  clientId: client,
  resourceId: resource,
  consentType: 'Principal',
  principalId: user,
  scope: scope.split(' ').sort().join(' '),
  ...patch,
});
const powershell = process.env.PWSH_EXECUTABLE || 'pwsh';
const available =
  spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$PSVersionTable.PSVersion.Major',
  ]).status === 0;
const suite = available ? describe : describe.skip;
const pair = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
function run(fixture: Fixture): { state: State; files: Record<string, string>; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'kisuno-consent-fixture-'));
  try {
    const script = join(directory, 'registration.ps1');
    writeFileSync(
      script,
      outlookRegistrationScript({
        id: '12345678-1234-4234-8234-123456789abc',
        publicKey: pair.publicKey,
        redirectUri: 'https://chat.example.test/api/mcp/kisuno-outlook/oauth/callback',
      }),
    );
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify(fixture));
    const result = spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(__dirname, '__tests__/registration.ps1'),
        script,
        join(directory, 'fixture.json'),
        join(directory, 'state.json'),
      ],
      { cwd: directory, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0 || result.error)
      throw new Error(`PowerShell fixture failed: ${result.stderr || result.error}`);
    const files = Object.fromEntries(
      readdirSync(directory)
        .filter((name) => name.startsWith('kisuno-outlook-'))
        .map((name) => [name, readFileSync(join(directory, name), 'utf8').replace(/^\uFEFF/, '')]),
    );
    return {
      state: JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8').replace(/^\uFEFF/, '')),
      files,
      output: result.stdout + result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
suite('real PowerShell registration with isolated Microsoft command fixtures', () => {
  it('captures consent before elevation and removes only newly added rights from an existing own grant', () => {
    const old = grant('User.Read Mail.Read');
    const { state, files } = run({ grants: [old] });
    expect(state.succeeded).toBe(true);
    expect(state.connects[0]).toEqual(['User.Read']);
    expect(state.connects[1]).toEqual(['https://graph.microsoft.com/.default']);
    expect(state.grants).toEqual([old]);
    expect(state.sessionEnded).toBe(true);
    const handoff = JSON.parse(Object.entries(files).find(([name]) => name.endsWith('.json'))![1]);
    expect(
      privateDecrypt(
        { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(handoff.ciphertext, 'base64'),
      ).toString(),
    ).toBe('fixture-only-password');
    expect(JSON.stringify(files)).not.toContain('fixture-only-password');
  });
  it('retains both pre-existing setup rights and does not request them again', () => {
    const old = grant('User.Read ' + setup.join(' '));
    const { state } = run({ grants: [old] });
    expect(state.succeeded).toBe(true);
    expect(state.grants).toEqual([old]);
    expect(state.connects).toHaveLength(2);
    expect(state.writes.filter((row) => ['PATCH', 'DELETE'].includes(row.method))).toEqual([]);
  });
  it.each(setup)(
    'retains the existing %s and requests/cleans only the missing right',
    (existing) => {
      const old = grant('User.Read ' + existing);
      const { state } = run({ grants: [old] });
      expect(state.succeeded).toBe(true);
      expect(state.grants).toEqual([old]);
      expect(state.connects[2]).toEqual(setup.filter((scope) => scope !== existing));
    },
  );
  it('preserves other administrators, other resources and the new mail-app consent', () => {
    const others = [
      grant(setup.join(' '), {
        id: 'other-admin',
        principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      grant('User.Read', {
        id: 'other-resource',
        resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ];
    const { state } = run({ grants: [grant('User.Read'), ...others] });
    expect(state.succeeded).toBe(true);
    expect(state.grants.filter((row) => row.id !== 'existing-own-grant')).toEqual(others);
    expect(
      state.writes.find((row) => row.path === '/oauth2PermissionGrants')?.body.scope,
    ).toContain('Mail.Read.Shared');
    expect(state.writes.some((row) => row.path.endsWith('/kisuno-mail-consent'))).toBe(false);
  });
  it('retains existing tenant-wide scopes when additional setup rights were consented tenant-wide', () => {
    const original = [
      grant('User.Read'),
      grant('Calendars.Read', {
        id: 'global-existing',
        consentType: 'AllPrincipals',
        principalId: null,
      }),
    ];
    const { state } = run({ grants: original, globalConsent: true });
    expect(state.succeeded).toBe(true);
    expect(state.grants).toEqual(original);
  });
  it('deletes only a new grant containing exclusively the newly introduced setup scopes', () => {
    const original = [grant('User.Read')];
    const { state } = run({ grants: original, globalConsent: true });
    expect(state.succeeded).toBe(true);
    expect(state.grants).toEqual(original);
    expect(state.writes.filter((row) => row.method === 'DELETE').map((row) => row.path)).toEqual([
      '/oauth2PermissionGrants/new-AllPrincipals',
    ]);
  });
  it('stops before cleanup writes on an observed concurrent consent change and retains the encrypted handoff', () => {
    const { state, files } = run({ grants: [grant('User.Read')], concurrentChange: true });
    expect(state.succeeded).toBe(false);
    expect(state.failure).toContain('parallel');
    expect(state.grants[0].scope).toContain('Group.Read.All');
    expect(state.writes.filter((row) => ['PATCH', 'DELETE'].includes(row.method))).toEqual([]);
    expect(Object.keys(files).some((name) => name.endsWith('.json'))).toBe(true);
  });
  it('reports cleanup denial without claiming success and always ends its own session', () => {
    const { state, output } = run({ grants: [grant('User.Read')], cleanupFailure: true });
    expect(state.succeeded).toBe(false);
    expect(output).not.toContain('Registrierung erfolgreich.');
    expect(state.sessionEnded).toBe(true);
  });
  it('also cleans its new setup rights when app creation fails', () => {
    const original = [grant('User.Read')];
    const { state } = run({ grants: original, creationFailure: true });
    expect(state.succeeded).toBe(false);
    expect(state.grants).toEqual(original);
    expect(state.sessionEnded).toBe(true);
  });
  it('waits for the new consent to become visible without repeating consent or writes', () => {
    const original = [grant('User.Read')];
    const { state } = run({ grants: original, snapshotDelay: 3 });
    expect(state.succeeded).toBe(true);
    expect(state.grants).toEqual(original);
    expect(state.connects).toHaveLength(4);
    expect(state.writes.filter((row) => row.path === '/applications')).toHaveLength(1);
  });
  it.each(['switchTenant', 'ambiguousBaseline'] as const)(
    'refuses %s before requesting setup rights',
    (key) => {
      const { state } = run({ grants: [grant('User.Read')], [key]: true });
      expect(state.succeeded).toBe(false);
      expect(state.connects).toHaveLength(2);
      expect(state.writes).toEqual([]);
    },
  );
  it('never follows an untrusted pagination URL or creates an app after an ambiguous snapshot', () => {
    const { state } = run({ grants: [grant('User.Read')], evilNext: true });
    expect(state.succeeded).toBe(false);
    expect(state.writes).toEqual([]);
  });
});
