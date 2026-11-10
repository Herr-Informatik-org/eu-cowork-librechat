import type { Collection } from 'mongodb';
import type { OpsPersonalGrant } from './types';

export interface OpsPersonalStore {
  create(grant: OpsPersonalGrant): Promise<void>;
  get(id: string): Promise<OpsPersonalGrant | null>;
  activate(
    id: string,
    codeHash: string,
    now: Date,
    accessHash: string,
    accessExpiresAt: Date,
    refreshHash: string,
  ): Promise<boolean>;
  rotate(
    id: string,
    refreshHash: string,
    now: Date,
    accessHash: string,
    accessExpiresAt: Date,
    nextRefreshHash: string,
  ): Promise<boolean>;
  revoke(id: string, now: Date, ownerId?: string): Promise<void>;
  list(ownerId: string, now: Date): Promise<OpsPersonalGrant[]>;
}

export function createMongoOpsPersonalStore(
  collection: () => Collection<OpsPersonalGrant>,
): OpsPersonalStore {
  let indexes: Promise<string[]> | undefined;
  const ready = async () => {
    indexes ??= Promise.all([
      collection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      collection().createIndex({ ownerId: 1, status: 1, createdAt: -1 }),
    ]).catch((error) => {
      indexes = undefined;
      throw error;
    });
    await indexes;
  };
  return {
    async create(grant) {
      await ready();
      await collection().insertOne(grant);
    },
    async get(id) {
      return collection().findOne({ _id: id });
    },
    async activate(id, codeHash, now, accessHash, accessExpiresAt, refreshHash) {
      const result = await collection().updateOne(
        {
          _id: id,
          status: 'pending',
          codeHash,
          codeExpiresAt: { $gt: now },
          expiresAt: { $gt: now },
        },
        { $set: { status: 'active', accessHash, accessExpiresAt, refreshHash } },
      );
      return result.modifiedCount === 1;
    },
    async rotate(id, refreshHash, now, accessHash, accessExpiresAt, nextRefreshHash) {
      const result = await collection().updateOne(
        {
          _id: id,
          status: 'active',
          refreshHash,
          expiresAt: { $gt: now },
          'usedRefreshHashes.4999': { $exists: false },
        },
        {
          $set: { accessHash, accessExpiresAt, refreshHash: nextRefreshHash },
          $push: { usedRefreshHashes: refreshHash },
        },
      );
      return result.modifiedCount === 1;
    },
    async revoke(id, now, ownerId) {
      await collection().updateOne(
        { _id: id, ...(ownerId ? { ownerId } : {}) },
        { $set: { status: 'revoked', revokedAt: now, accessHash: '', refreshHash: '' } },
      );
    },
    async list(ownerId, now) {
      return collection()
        .find({ ownerId, status: 'active', expiresAt: { $gt: now } })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
    },
  };
}
