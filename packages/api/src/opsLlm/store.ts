import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Collection, Document } from 'mongodb';
import type { Limits, KeyInput } from './config';
import { OpsLlmError, keySchema } from './config';

export interface OpsKey {
  _id: string;
  tenant: 'cwv01';
  hash: string;
  name: string;
  modules: string[];
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}
interface Lease {
  id: string;
  key: string;
  expiresAt: number;
}
interface Tick {
  key: string;
  at: number;
}
interface Quota {
  _id: string;
  revision: number;
  leases: Lease[];
  ticks: Tick[];
}
export interface OpsUsage {
  key: string;
  module: string;
  model: string | null;
  status: 'success' | 'error';
  errorCode: string | null;
  input: number | null;
  output: number | null;
  durationMs: number;
}
interface Usage extends OpsUsage {
  _id: string;
  at: Date;
  expiresAt: Date;
}
export type OpsKeyMetadata = Omit<OpsKey, '_id' | 'tenant' | 'hash'> & { id: string };
export interface OpsStore {
  list(): Promise<OpsKeyMetadata[]>;
  create(input: KeyInput): Promise<{ key: string; record: OpsKeyMetadata }>;
  rotate(id: string): Promise<{ key: string; record: OpsKeyMetadata }>;
  revoke(id: string): Promise<{ revoked: boolean }>;
  authorize(authorization: string | undefined, module: string | undefined): Promise<OpsKey>;
  active(key: OpsKey): Promise<void>;
  reserve(key: string, limits: Limits): Promise<() => Promise<void>>;
  meter(event: OpsUsage): Promise<void>;
}
export type Collections = <T extends Document>(name: string) => Collection<T>;
export const hashOpsKey = (key: string): string => createHash('sha256').update(key).digest('hex');
export const opsKeyMetadata = (key: OpsKey): OpsKeyMetadata => ({
  id: key._id,
  name: key.name,
  modules: key.modules,
  createdAt: key.createdAt,
  revokedAt: key.revokedAt,
  lastUsedAt: key.lastUsedAt,
});
export function createOpsStore(collection: Collections, now: () => number = Date.now): OpsStore {
  const keys = () => collection<OpsKey>('eucowork_ops_llm_keys');
  const quotas = () => collection<Quota>('eucowork_ops_llm_quota');
  const usage = () => collection<Usage>('eucowork_ops_llm_usage');
  let usageIndex: Promise<string> | undefined;
  return {
    async list() {
      return (
        await keys()
          .find({ tenant: 'cwv01' })
          .sort({ revokedAt: 1, createdAt: -1 })
          .limit(500)
          .toArray()
      ).map(opsKeyMetadata);
    },
    async create(input: { name: string; modules: string[] }) {
      const parsed = keySchema.parse(input);
      if (
        (await keys().countDocuments({ tenant: 'cwv01', revokedAt: null }, { limit: 100 })) >= 100
      )
        throw new OpsLlmError(409, 'key_limit', 'Höchstens 100 aktive Schlüssel sind erlaubt.');
      const secret = `kops_${randomBytes(32).toString('base64url')}`;
      const key: OpsKey = {
        _id: randomUUID(),
        tenant: 'cwv01',
        hash: hashOpsKey(secret),
        name: parsed.name,
        modules: [...new Set(parsed.modules)],
        createdAt: new Date(now()),
        revokedAt: null,
        lastUsedAt: null,
      };
      await keys().insertOne(key);
      return { key: secret, record: opsKeyMetadata(key) };
    },
    async rotate(id: string) {
      const secret = `kops_${randomBytes(32).toString('base64url')}`;
      const key = await keys().findOneAndUpdate(
        { _id: id, tenant: 'cwv01', revokedAt: null },
        { $set: { hash: hashOpsKey(secret) } },
        { returnDocument: 'after' },
      );
      if (!key)
        throw new OpsLlmError(404, 'key_not_found', 'Der aktive Schlüssel wurde nicht gefunden.');
      return { key: secret, record: opsKeyMetadata(key) };
    },
    async revoke(id: string) {
      const result = await keys().updateOne(
        { _id: id, tenant: 'cwv01' },
        { $set: { revokedAt: new Date(now()) } },
      );
      if (!result.matchedCount)
        throw new OpsLlmError(404, 'key_not_found', 'Der Schlüssel wurde nicht gefunden.');
      return { revoked: true };
    },
    async authorize(authorization: string | undefined, module: string | undefined) {
      if (!authorization || !/^Bearer kops_[A-Za-z0-9_-]{43}$/.test(authorization))
        throw new OpsLlmError(401, 'invalid_api_key', 'Der API-Schlüssel fehlt oder ist ungültig.');
      const key = await keys().findOne({
        tenant: 'cwv01',
        hash: hashOpsKey(authorization.slice(7)),
        revokedAt: null,
      });
      if (!key)
        throw new OpsLlmError(401, 'invalid_api_key', 'Der API-Schlüssel fehlt oder ist ungültig.');
      if (!module || !key.modules.includes(module))
        throw new OpsLlmError(
          403,
          'module_not_allowed',
          'Dieses Modul ist für den Schlüssel nicht freigegeben.',
        );
      return key;
    },
    async active(key: OpsKey) {
      if (
        !(await keys().findOne({ _id: key._id, tenant: 'cwv01', hash: key.hash, revokedAt: null }))
      )
        throw new OpsLlmError(
          401,
          'invalid_api_key',
          'Der API-Schlüssel wurde widerrufen oder erneuert.',
        );
    },
    async reserve(key: string, limits: Limits) {
      try {
        await quotas().updateOne(
          { _id: 'cwv01' },
          { $setOnInsert: { revision: 0, leases: [], ticks: [] } },
          { upsert: true },
        );
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await quotas().findOne({ _id: 'cwv01' });
        if (!current)
          throw new OpsLlmError(503, 'quota_unavailable', 'Die Begrenzung ist nicht verfügbar.');
        const time = now();
        const leases = current.leases.filter((item) => item.expiresAt > time);
        const ticks = current.ticks.filter((item) => item.at > time - 60000);
        if (
          leases.length >= limits.globalParallel ||
          leases.filter((item) => item.key === key).length >= limits.parallel ||
          ticks.length >= limits.globalRpm ||
          ticks.filter((item) => item.key === key).length >= limits.rpm
        )
          throw new OpsLlmError(
            429,
            'rate_limit_exceeded',
            'Die Schnittstelle ist ausgelastet. Bitte später erneut versuchen.',
            60,
          );
        const id = randomUUID();
        const result = await quotas().updateOne(
          { _id: 'cwv01', revision: current.revision },
          {
            $set: {
              leases: [...leases, { id, key, expiresAt: time + limits.timeoutMs + 10000 }],
              ticks: [...ticks, { key, at: time }],
            },
            $inc: { revision: 1 },
          },
        );
        if (result.modifiedCount)
          return async () => {
            await quotas().updateOne(
              { _id: 'cwv01' },
              { $pull: { leases: { id } }, $inc: { revision: 1 } },
            );
          };
      }
      throw new OpsLlmError(
        429,
        'rate_limit_exceeded',
        'Die Schnittstelle ist ausgelastet. Bitte später erneut versuchen.',
        2,
      );
    },
    async meter(event: OpsUsage) {
      usageIndex ??= usage().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      try {
        await usageIndex;
      } catch (error) {
        usageIndex = undefined;
        throw error;
      }
      const at = new Date(now());
      await usage().insertOne({
        ...event,
        _id: randomUUID(),
        at,
        expiresAt: new Date(at.getTime() + 30 * 86400000),
      });
      await keys().updateOne({ _id: event.key, tenant: 'cwv01' }, { $set: { lastUsedAt: at } });
    },
  };
}
