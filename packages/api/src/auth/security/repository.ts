import { ObjectId } from 'mongodb';
import type { Binary, Db } from 'mongodb';
import type { Credential, SecurityStore } from './engine';
import type { SecurityAccount } from './protocol';
import { opaque } from './protocol';

interface ChallengeRow {
  _id: string;
  value: string;
  expiresAt: Date;
}
interface RateRow {
  _id: string;
  count: number;
  expiresAt: Date;
}
interface LockRow {
  _id: string;
  token: string;
  expiresAt: Date;
}
interface StoredCredential extends Omit<Credential, 'publicKey'> {
  publicKey: Buffer | Binary;
}
export interface AccountRepository {
  read(id: string): Promise<SecurityAccount | null>;
  patch(id: string, version: number, fields: Partial<SecurityAccount>): Promise<SecurityAccount>;
  recovery(id: string, hash: string): Promise<boolean>;
}

interface AccountRow extends Omit<SecurityAccount, 'id'> {
  _id: ObjectId;
}
export function createSecurityAccounts(
  db: Db,
  collection: string,
  invalidate: (id: string) => Promise<void>,
): AccountRepository {
  const users = db.collection<AccountRow>(collection);
  const read = async (id: string): Promise<SecurityAccount | null> => {
    if (!ObjectId.isValid(id)) return null;
    const row = await users.findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          email: 1,
          name: 1,
          role: 1,
          tenantId: 1,
          provider: 1,
          securityVersion: 1,
          securityEnrolled: 1,
          twoFactorEnabled: 1,
          totpSecret: 1,
          pendingTotpSecret: 1,
          pendingTotpExpires: 1,
          backupCodes: 1,
          disabled: 1,
          disabledAt: 1,
        },
      },
    );
    return row
      ? {
          ...row,
          id: row._id.toHexString(),
          tenantId: row.tenantId ? String(row.tenantId) : undefined,
        }
      : null;
  };
  return {
    read,
    async patch(id, version, fields) {
      const guard =
        version === 0
          ? { $or: [{ securityVersion: 0 }, { securityVersion: { $exists: false } }] }
          : { securityVersion: version };
      const result = await users.updateOne({ _id: new ObjectId(id), ...guard }, { $set: fields });
      if (result.matchedCount !== 1)
        throw Object.assign(new Error('Sicherheitsstand wurde geändert. Bitte erneut anmelden.'), {
          status: 409,
        });
      await invalidate(id);
      const user = await read(id);
      if (!user) throw new Error('Konto nicht gefunden.');
      return user;
    },
    async recovery(id, hash) {
      const result = await users.updateOne(
        { _id: new ObjectId(id), backupCodes: { $elemMatch: { codeHash: hash, used: false } } },
        { $set: { 'backupCodes.$.used': true, 'backupCodes.$.usedAt': new Date() } },
      );
      if (result.modifiedCount === 1) await invalidate(id);
      return result.modifiedCount === 1;
    },
  };
}

export async function createSecurityStore(
  db: Db,
  accounts: AccountRepository,
): Promise<SecurityStore> {
  const challenges = db.collection<ChallengeRow>('kisuno_security_challenges');
  const credentials = db.collection<StoredCredential>('kisuno_passkeys');
  const rates = db.collection<RateRow>('kisuno_security_rates');
  const locks = db.collection<LockRow>('kisuno_security_locks');
  await Promise.all([
    challenges.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    credentials.createIndex({ credentialId: 1 }, { unique: true }),
    credentials.createIndex({ userId: 1, slot: 1 }, { unique: true }),
    rates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    locks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  const normalize = (row: StoredCredential): Credential => ({
    ...row,
    publicKey: Buffer.isBuffer(row.publicKey) ? row.publicKey : Buffer.from(row.publicKey.buffer),
  });
  return {
    account: accounts.read,
    update: accounts.patch,
    consumeRecovery: accounts.recovery,
    async get(key) {
      return (await challenges.findOne({ _id: key, expiresAt: { $gt: new Date() } }))?.value;
    },
    async set(key, value, ttl = 300_000) {
      await challenges.updateOne(
        { _id: key },
        { $set: { value, expiresAt: new Date(Date.now() + ttl) } },
        { upsert: true },
      );
    },
    async delete(key) {
      return (
        (await challenges.deleteOne({ _id: key, expiresAt: { $gt: new Date() } })).deletedCount ===
        1
      );
    },
    async getDel(key) {
      return (await challenges.findOneAndDelete({ _id: key, expiresAt: { $gt: new Date() } }))
        ?.value;
    },
    async claimTotp(id, secretHash, step) {
      try {
        await challenges.insertOne({
          _id: 'totp-used:' + id + ':' + secretHash + ':' + step,
          value: 'used',
          expiresAt: new Date(Date.now() + 120_000),
        });
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
      }
    },
    async credentials(id) {
      return (await credentials.find({ userId: id }).sort({ slot: 1 }).toArray()).map(normalize);
    },
    async credential(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(id)) return null;
      const row = await credentials.findOne({ credentialId: id });
      return row ? normalize(row) : null;
    },
    async addCredential(value) {
      await credentials.insertOne({ ...value, createdAt: new Date() });
    },
    async removeCredential(id, userId) {
      await credentials.deleteOne({ credentialId: id, userId });
    },
    async recordUse(id, previous, next, backedUp) {
      if (next < previous || (previous > 0 && next <= previous)) return false;
      const result = await credentials.updateOne(
        { credentialId: id, counter: previous },
        { $set: { counter: next, backedUp } },
      );
      return result.matchedCount === 1;
    },
    async rate(key, maximum, windowMs) {
      const bucket = Math.floor(Date.now() / windowMs);
      const result = await rates.findOneAndUpdate(
        { _id: key + ':' + bucket },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } },
        { upsert: true, returnDocument: 'after' },
      );
      return !!result && result.count <= maximum;
    },
    async withLock(id, callback) {
      const token = opaque();
      try {
        const lock = await locks.findOneAndUpdate(
          { _id: id, expiresAt: { $lte: new Date() } },
          { $set: { token, expiresAt: new Date(Date.now() + 120_000) } },
          { upsert: true, returnDocument: 'after' },
        );
        if (!lock || lock.token !== token) throw new Error('Sicherheitsänderung läuft bereits.');
      } catch {
        throw Object.assign(
          new Error('Eine Sicherheitsänderung läuft bereits. Bitte kurz warten.'),
          { status: 409 },
        );
      }
      try {
        return await callback();
      } finally {
        await locks.deleteOne({ _id: id, token });
      }
    },
  };
}
