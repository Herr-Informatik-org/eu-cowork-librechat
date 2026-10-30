import { Types } from 'mongoose';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from 'mongoose';
import { CacheKeys } from 'librechat-data-provider';
import { invalidateCachedAuthUserDoc } from '~/auth/userDocCache';
import { standardCache } from '~/cache/cacheFactory';

const ROLE = 'KISUNO_SUPPORT_RUNTIME';
const EMAIL = 'support-runtime@kisuno.invalid';
const AGENT = 'kisuno-support-runtime-v1';
const MARKER = 'kisuno-support-runtime-v1';
const KEY_NAME = 'Interner Kisuno-Supportdienst';
const KEY_PREFIX = 'sk-';

interface ProvisionState {
  version: 1;
  provider: string;
  model: string;
  userId: string;
  agentRecordId: string;
  roleId: string;
  aclId: string;
  keyId: string;
  key: string;
}

export interface SupportRuntimeProfile {
  version: number;
  userId: string;
  agentId: string;
  provider: string;
  model: string;
}

interface ProvisionOptions {
  outputDirectory: string;
  provider: string;
  model: string;
}

export class SupportProvisionError extends Error {}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(): never {
  throw new SupportProvisionError(
    'Supporteinrichtung abgebrochen: vorhandener Zustand stimmt nicht mit dem geschützten Einrichtungsstand überein.',
  );
}

async function privateFile(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) fail();
    return await readFile(file, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

async function writePrivate(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function parseState(value: string, options: ProvisionOptions): ProvisionState {
  const state: ProvisionState = JSON.parse(value);
  if (
    !state ||
    state.version !== 1 ||
    state.provider !== options.provider ||
    state.model !== options.model ||
    !/^sk-[a-f0-9]{64}$/.test(state.key)
  )
    fail();
  for (const value of [state.userId, state.agentRecordId, state.roleId, state.aclId, state.keyId]) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) fail();
  }
  if (
    Object.keys(state).sort().join(',') !==
    'aclId,agentRecordId,key,keyId,model,provider,roleId,userId,version'
  )
    fail();
  return state;
}

function sameValue(actual: object, expected: object, ignored: string[] = []): boolean {
  const normalize = (value: object): string =>
    JSON.stringify(value, (key, entry) => {
      if (ignored.includes(key)) return undefined;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        );
      }
      return entry;
    });
  return normalize(actual) === normalize(expected);
}

function runtimeEntries(db: NonNullable<Connection['db']>, state: ProvisionState) {
  const userId = new Types.ObjectId(state.userId);
  const agentId = new Types.ObjectId(state.agentRecordId);
  const user = {
    _id: userId,
    email: EMAIL,
    username: 'kisuno-support-runtime',
    name: 'Kisuno Supportdienst',
    emailVerified: false,
    provider: 'kisuno-support-runtime',
    role: ROLE,
    refreshToken: [],
    personalization: { memories: false },
  };
  const role = {
    _id: new Types.ObjectId(state.roleId),
    name: ROLE,
    description: 'Ausschliesslich interner Supportanalysezugriff',
    permissions: {
      REMOTE_AGENTS: { USE: true, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
    },
  };
  const agent = {
    _id: agentId,
    id: AGENT,
    name: 'Kisuno Supportanalyse',
    author: userId,
    provider: state.provider,
    model: state.model,
    instructions: '',
    tools: [],
    actions: [],
    skills: [],
    skills_enabled: false,
    stateful_code_sessions: false,
    agent_ids: [],
    edges: [],
    tool_resources: {},
    model_parameters: {},
    recursion_limit: 2,
  };
  const acl = {
    _id: new Types.ObjectId(state.aclId),
    principalType: 'user',
    principalModel: 'User',
    principalId: userId,
    resourceType: 'remoteAgent',
    resourceId: agentId,
    permBits: 1,
  };
  const key = {
    _id: new Types.ObjectId(state.keyId),
    userId,
    name: KEY_NAME,
    keyHash: hash(state.key),
    keyPrefix: state.key.slice(0, 8),
  };
  const entries = [
    {
      collection: db.collection('users'),
      query: { $or: [{ email: EMAIL }, { _id: userId }, { role: ROLE }] },
      document: user,
      ignored: ['createdAt', 'updatedAt', '__v'],
    },
    {
      collection: db.collection('roles'),
      query: { $or: [{ name: ROLE }, { _id: role._id }] },
      document: role,
      ignored: ['createdAt', 'updatedAt', '__v'],
    },
    {
      collection: db.collection('agents'),
      query: { $or: [{ id: AGENT }, { author: userId }, { _id: agentId }] },
      document: agent,
      ignored: ['createdAt', 'updatedAt', '__v'],
    },
    {
      collection: db.collection('aclentries'),
      query: {
        $or: [
          { principalId: userId },
          { resourceId: agentId },
          { principalId: ROLE },
          { _id: acl._id },
        ],
      },
      document: acl,
      ignored: ['createdAt', 'updatedAt', '__v'],
    },
    {
      collection: db.collection('agentapikeys'),
      query: { $or: [{ userId }, { name: KEY_NAME }, { _id: key._id }] },
      document: key,
      ignored: ['createdAt', 'updatedAt', 'lastUsedAt', '__v'],
    },
  ];
  return { userId, entries };
}

/** Provision one non-interactive service identity; never alter a pre-existing account. */
export async function provisionSupportRuntime(
  connection: Connection,
  options: ProvisionOptions,
): Promise<SupportRuntimeProfile> {
  if (
    !connection.db ||
    !path.isAbsolute(options.outputDirectory) ||
    !/^[A-Za-z0-9 _.-]{1,100}$/.test(options.provider) ||
    !/^[A-Za-z0-9_.:/-]{1,200}$/.test(options.model)
  ) {
    throw new SupportProvisionError(
      'Supporteinrichtung benötigt eine Datenbank, einen absoluten geschützten Zielpfad und ein festes Anbieter-/Modellprofil.',
    );
  }
  if (
    process.env.TENANT_ISOLATION_STRICT === 'true' ||
    process.env.MULTI_TENANT === 'true' ||
    process.env.MULTI_TENANT_MODE === 'true'
  ) {
    throw new SupportProvisionError(
      'Diese Einrichtung ist ausschliesslich für eine Einzelinstanz freigegeben.',
    );
  }
  await mkdir(options.outputDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const directoryInfo = await lstat(options.outputDirectory);
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    directoryInfo.uid !== process.getuid?.()
  )
    fail();
  const lockPath = path.join(options.outputDirectory, '.provision.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new SupportProvisionError(
      'Supporteinrichtung ist bereits gesperrt. Einen unterbrochenen Lauf vor einer erneuten Einrichtung prüfen.',
    );
  });
  try {
    const db = connection.db;
    const markers = db.collection<{
      _id: string;
      stateHash: string;
      phase: 'prepared' | 'complete';
    }>('eucowork_support_runtime');
    const marker = await markers.findOne({ _id: MARKER });
    const statePath = path.join(options.outputDirectory, 'provision-state.json');
    const saved = await privateFile(statePath);
    if (marker && !saved) fail();
    const state: ProvisionState = saved
      ? parseState(saved, options)
      : {
          version: 1,
          provider: options.provider,
          model: options.model,
          userId: new Types.ObjectId().toString(),
          agentRecordId: new Types.ObjectId().toString(),
          roleId: new Types.ObjectId().toString(),
          aclId: new Types.ObjectId().toString(),
          keyId: new Types.ObjectId().toString(),
          key: `${KEY_PREFIX}${randomBytes(32).toString('hex')}`,
        };
    const stateHash = hash(JSON.stringify(state));
    if (
      marker &&
      (marker.stateHash !== stateHash || !['prepared', 'complete'].includes(marker.phase))
    )
      fail();
    const { userId, entries } = runtimeEntries(db, state);
    for (const entry of entries) {
      const found = await entry.collection.find(entry.query).toArray();
      if (
        found.length > 1 ||
        (marker?.phase === 'complete' && found.length !== 1) ||
        (found.length && (!marker || !sameValue(found[0], entry.document, entry.ignored)))
      )
        fail();
    }
    if (await db.collection('groups').findOne({ memberIds: userId })) fail();
    if (!saved) await writePrivate(statePath, `${JSON.stringify(state)}\n`);
    if (!marker) await markers.insertOne({ _id: MARKER, stateHash, phase: 'prepared' });
    for (const entry of entries) {
      await entry.collection.updateOne(
        { _id: entry.document._id },
        { $setOnInsert: entry.document },
        { upsert: true },
      );
      const actual = await entry.collection.findOne({ _id: entry.document._id });
      if (!actual || !sameValue(actual, entry.document, entry.ignored)) fail();
    }
    const profile = {
      version: 1,
      userId: state.userId,
      agentId: AGENT,
      provider: state.provider,
      model: state.model,
    };
    const profilePath = path.join(options.outputDirectory, 'runtime-profile.json');
    const keyPath = path.join(options.outputDirectory, 'runtime-key');
    const oldKey = await privateFile(keyPath);
    const oldProfile = await privateFile(profilePath);
    if (
      (marker?.phase === 'complete' && (!oldKey || !oldProfile)) ||
      (oldKey && oldKey !== `${state.key}\n`) ||
      (oldProfile && oldProfile !== `${JSON.stringify(profile)}\n`)
    )
      fail();
    if (!oldKey) await writePrivate(keyPath, `${state.key}\n`);
    if (!oldProfile) await writePrivate(profilePath, `${JSON.stringify(profile)}\n`);
    await markers.updateOne({ _id: MARKER, stateHash }, { $set: { phase: 'complete' } });
    return profile;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Disable only the exact technical identity owned by this installation. */
export async function disableSupportRuntime(
  connection: Connection,
  outputDirectory: string,
): Promise<void> {
  if (!connection.db || !path.isAbsolute(outputDirectory)) fail();
  if (
    process.env.AUTH_USER_CACHE_MODE === 'on' &&
    (!process.env.REDIS_URI || process.env.USE_REDIS !== 'true')
  ) {
    throw new SupportProvisionError(
      'Für den aktiven Benutzer-Cache müssen die bestehenden Redis-Einstellungen übergeben werden.',
    );
  }
  const directoryInfo = await lstat(outputDirectory);
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    directoryInfo.uid !== process.getuid?.()
  )
    fail();
  const lockPath = path.join(outputDirectory, '.provision.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new SupportProvisionError(
      'Supporteinrichtung ist bereits gesperrt. Einen unterbrochenen Lauf zuerst prüfen.',
    );
  });
  try {
    const saved = await privateFile(path.join(outputDirectory, 'provision-state.json'));
    if (!saved) fail();
    const draft: ProvisionState = JSON.parse(saved);
    const state = parseState(saved, {
      outputDirectory,
      provider: draft.provider,
      model: draft.model,
    });
    const db = connection.db;
    const markers = db.collection<{
      _id: string;
      stateHash: string;
      phase: string;
      partial?: boolean;
    }>('eucowork_support_runtime');
    const stateHash = hash(JSON.stringify(state));
    const marker = await markers.findOne({ _id: MARKER });
    if (
      !marker ||
      marker.stateHash !== stateHash ||
      !['prepared', 'complete', 'disabling', 'disabled'].includes(marker.phase)
    )
      fail();
    const { userId, entries } = runtimeEntries(db, state);
    if (await db.collection('groups').findOne({ memberIds: userId })) fail();
    for (const entry of entries) {
      const found = await entry.collection.find(entry.query).toArray();
      const removable = ['users', 'agentapikeys'].includes(entry.collection.collectionName);
      if (
        found.length > 1 ||
        (found.length && !sameValue(found[0], entry.document, entry.ignored)) ||
        (!removable && marker.phase !== 'prepared' && !marker.partial && found.length !== 1) ||
        (removable && marker.phase === 'disabled' && found.length)
      )
        fail();
    }
    if (marker.phase === 'disabled') return;
    await markers.updateOne(
      { _id: MARKER, stateHash },
      {
        $set: {
          phase: 'disabling',
          partial: marker.phase === 'prepared' || Boolean(marker.partial),
        },
      },
    );
    for (const name of ['agentapikeys', 'users']) {
      const entry = entries.find((candidate) => candidate.collection.collectionName === name)!;
      const actual = await entry.collection.findOne({ _id: entry.document._id });
      if (!actual) continue;
      if (!sameValue(actual, entry.document, entry.ignored)) fail();
      await entry.collection.deleteOne({
        ...actual,
        $expr: {
          $setEquals: [
            { $map: { input: { $objectToArray: '$$ROOT' }, as: 'field', in: '$$field.k' } },
            Object.keys(actual),
          ],
        },
      });
      if (await entry.collection.findOne({ _id: entry.document._id })) fail();
    }
    if (process.env.AUTH_USER_CACHE_MODE === 'on') {
      await invalidateCachedAuthUserDoc(standardCache(CacheKeys.AUTH_USER_DOC), {
        userId: state.userId,
      });
    }
    await markers.updateOne({ _id: MARKER, stateHash }, { $set: { phase: 'disabled' } });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
