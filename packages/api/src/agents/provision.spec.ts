import mongoose from 'mongoose';
import { mkdtemp, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { provisionSupportRuntime, disableSupportRuntime } from './provision';
import { findOpenIDUser } from '~/auth/openid';

let mongo: MongoMemoryServer;
let directory: string;
const options = () => ({
  outputDirectory: path.join(directory, 'private'),
  provider: 'EuRouter',
  model: 'mistral-large-3',
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({
    binary: process.env.MONGOMS_SYSTEM_BINARY
      ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY }
      : undefined,
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
}, 30000);
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  directory = await mkdtemp(path.join(tmpdir(), 'kisuno-runtime-provision-'));
});
afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

const run = () => provisionSupportRuntime(mongoose.connection, options());
const db = () => mongoose.connection.db!;

test('creates only one private non-login service identity and a native hashed credential', async () => {
  const profile = await run();
  const user = await db()
    .collection('users')
    .findOne({ _id: new mongoose.Types.ObjectId(profile.userId) });
  expect(user).toMatchObject({
    role: 'KISUNO_SUPPORT_RUNTIME',
    emailVerified: false,
    provider: 'kisuno-support-runtime',
    refreshToken: [],
    personalization: { memories: false },
  });
  expect(user).not.toHaveProperty('password');
  expect(user).not.toHaveProperty('openidId');
  const raw = (await readFile(path.join(options().outputDirectory, 'runtime-key'), 'utf8')).trim();
  const native = createMethods(mongoose);
  expect((await native.validateAgentApiKey(raw))?.userId.toString()).toBe(profile.userId);
  const key = await db()
    .collection('agentapikeys')
    .findOne({ userId: new mongoose.Types.ObjectId(profile.userId) });
  expect(JSON.stringify(key)).not.toContain(raw);
  const acl = await db()
    .collection('aclentries')
    .findOne({ principalId: new mongoose.Types.ObjectId(profile.userId) });
  expect(acl).toMatchObject({ resourceType: 'remoteAgent', permBits: 1 });
  for (const name of ['provision-state.json', 'runtime-key', 'runtime-profile.json']) {
    expect((await stat(path.join(options().outputDirectory, name))).mode & 0o777).toBe(0o600);
  }
  expect((await stat(options().outputDirectory)).mode & 0o777).toBe(0o700);
  expect(
    await readFile(path.join(options().outputDirectory, 'runtime-profile.json'), 'utf8'),
  ).not.toContain(raw);
});

test('rerun verifies the same account and credential without changing either', async () => {
  const profile = await run();
  const raw = await readFile(path.join(options().outputDirectory, 'runtime-key'), 'utf8');
  expect(await run()).toEqual(profile);
  expect(await readFile(path.join(options().outputDirectory, 'runtime-key'), 'utf8')).toBe(raw);
  expect(await db().collection('users').countDocuments()).toBe(1);
  expect(await db().collection('agentapikeys').countDocuments()).toBe(1);
});

test.each([
  ['users', { email: 'support-runtime@kisuno.invalid' }],
  ['roles', { name: 'KISUNO_SUPPORT_RUNTIME' }],
  ['agents', { id: 'kisuno-support-runtime-v1' }],
  ['agentapikeys', { name: 'Interner Kisuno-Supportdienst' }],
])('refuses pre-existing reserved objects in %s', async (collection, document) => {
  await db()
    .collection(collection as string)
    .insertOne(document as object);
  await expect(run()).rejects.toThrow('vorhandener Zustand');
  expect(await db().collection('eucowork_support_runtime').countDocuments()).toBe(0);
});

test.each([
  ['users', { password: 'unexpected', provider: 'local' }],
  ['roles', { permissions: { REMOTE_AGENTS: { USE: true, CREATE: true } } }],
  ['agents', { tools: ['send_email'] }],
  ['aclentries', { permBits: 15 }],
  ['agentapikeys', { keyHash: 'changed' }],
])('refuses modified security properties in %s', async (collection, update) => {
  await run();
  await db()
    .collection(collection as string)
    .updateOne({}, { $set: update as object });
  await expect(run()).rejects.toThrow('vorhandener Zustand');
});

test('refuses missing private source state and a widened private directory', async () => {
  await run();
  await chmod(options().outputDirectory, 0o755);
  await expect(run()).rejects.toThrow('vorhandener Zustand');
  await chmod(options().outputDirectory, 0o700);
  await rm(path.join(options().outputDirectory, 'provision-state.json'));
  await expect(run()).rejects.toThrow('vorhandener Zustand');
});

test('refuses any additional service credential', async () => {
  const profile = await run();
  await db()
    .collection('agentapikeys')
    .insertOne({ userId: new mongoose.Types.ObjectId(profile.userId), name: 'other' });
  await expect(run()).rejects.toThrow('vorhandener Zustand');
});

test('does not recreate a revoked key after completed provisioning', async () => {
  await run();
  await db().collection('agentapikeys').deleteMany({});
  await expect(run()).rejects.toThrow('vorhandener Zustand');
  expect(await db().collection('agentapikeys').countDocuments()).toBe(0);
});

test('does not restore a missing runtime secret after completed provisioning', async () => {
  await run();
  await rm(path.join(options().outputDirectory, 'runtime-key'));
  await expect(run()).rejects.toThrow('vorhandener Zustand');
});

test('the native principal and ACL resolver grants only remote view', async () => {
  const profile = await run();
  const methods = createMethods(mongoose);
  const principal = await methods.getUserPrincipals({
    userId: profile.userId,
    role: 'KISUNO_SUPPORT_RUNTIME',
  });
  const agent = await db().collection('agents').findOne({ id: profile.agentId });
  expect(await methods.getEffectivePermissions(principal, 'remoteAgent', agent!._id)).toBe(1);
  expect(await methods.getEffectivePermissions(principal, 'agent', agent!._id)).toBe(0);
});

test('disable removes only the pristine service user and key and leaves audit references', async () => {
  const profile = await run();
  await db().collection('transactions').insertOne({ user: profile.userId, tokens: 12 });
  await disableSupportRuntime(mongoose.connection, options().outputDirectory);
  expect(await db().collection('users').countDocuments()).toBe(0);
  expect(await db().collection('agentapikeys').countDocuments()).toBe(0);
  for (const collection of ['roles', 'agents', 'aclentries', 'transactions'])
    expect(await db().collection(collection).countDocuments()).toBe(1);
  await disableSupportRuntime(mongoose.connection, options().outputDirectory);
  await expect(run()).rejects.toThrow('vorhandener Zustand');
  expect((await db().collection('eucowork_support_runtime').findOne({}))?.phase).toBe('disabled');
});

test('disable resumes safely after the key was removed before an interrupted account removal', async () => {
  await run();
  await db().collection('agentapikeys').deleteMany({});
  await db()
    .collection('eucowork_support_runtime')
    .updateOne({}, { $set: { phase: 'disabling' } });
  await disableSupportRuntime(mongoose.connection, options().outputDirectory);
  expect(await db().collection('users').countDocuments()).toBe(0);
});

test('disable cleans up a partial initial setup without recreating absent objects', async () => {
  await run();
  await db().collection('agentapikeys').deleteMany({});
  await db().collection('aclentries').deleteMany({});
  await db()
    .collection('eucowork_support_runtime')
    .updateOne({}, { $set: { phase: 'prepared' } });
  await disableSupportRuntime(mongoose.connection, options().outputDirectory);
  await disableSupportRuntime(mongoose.connection, options().outputDirectory);
  expect(await db().collection('users').countDocuments()).toBe(0);
  expect(await db().collection('aclentries').countDocuments()).toBe(0);
});

test.each([
  { password: 'unexpected' },
  { refreshToken: [{ refreshToken: 'unexpected' }] },
  { openidId: 'unexpected' },
])(
  'disable refuses a technical identity converted to an interactive account: %s',
  async (update) => {
    await run();
    await db().collection('users').updateOne({}, { $set: update });
    await expect(
      disableSupportRuntime(mongoose.connection, options().outputDirectory),
    ).rejects.toThrow('vorhandener Zustand');
    expect(await db().collection('users').countDocuments()).toBe(1);
    expect(await db().collection('agentapikeys').countDocuments()).toBe(1);
  },
);

test('the real OpenID resolver rejects email fallback to the technical account', async () => {
  await run();
  const methods = createMethods(mongoose);
  const result = await findOpenIDUser({
    openidId: 'synthetic-subject',
    email: 'support-runtime@kisuno.invalid',
    openidIssuer: 'https://identity.example.invalid',
    findUser: methods.findUser,
  });
  expect(result.user).toBeNull();
  expect(result.error).toBeTruthy();
  const user = await db().collection('users').findOne({ email: 'support-runtime@kisuno.invalid' });
  expect(user).not.toHaveProperty('openidId');
});
