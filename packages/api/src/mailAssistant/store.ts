import type { Collection, Document } from 'mongodb';
import type { MailCheckpoint, MailJob, MailStore, StoredMailResult } from './types';
import type { MailCodec } from './privateData';
import { nextMailRun } from './schedule';

interface Row extends Omit<MailJob, 'checkpoint'> {
  _id: string;
  checkpointEncrypted?: string;
  results?: Record<string, { encrypted: string; updatedAt: Date }>;
}
export interface MailDraftOperation {
  _id: string;
  ownerId: string;
  sourceHash: string;
  state: 'pending' | 'completed' | 'failed';
  reservationToken?: string;
}

/** One account document makes lease-fenced checkpoints and results atomic. Content is encrypted. */
export function createMongoMailStore({
  collection,
  operations,
  codec,
}: {
  collection: () => Collection<Row>;
  operations: () => Collection<MailDraftOperation>;
  codec: MailCodec;
}): MailStore {
  const decode = (row: Row): MailJob => {
    const { checkpointEncrypted, results: _results, _id: _id, ...job } = row;
    return {
      ...job,
      ...(checkpointEncrypted && {
        checkpoint: codec.open<MailCheckpoint>(row.ownerId, 'checkpoint', checkpointEncrypted),
      }),
    };
  };
  const fieldsFor = (owner: string, fields: Partial<MailJob>): Document => {
    const result: Document = {};
    for (const name of ['lastRunAt', 'nextRunAt', 'lastError', 'leaseUntil'] as const) {
      if (fields[name] !== undefined) result[name] = fields[name];
    }
    if (fields.checkpoint)
      result.checkpointEncrypted = codec.seal(owner, 'checkpoint', fields.checkpoint);
    return result;
  };
  const read = async (owner: string) => {
    const row = await collection().findOne({ _id: owner, ownerId: owner });
    return row ? decode(row) : null;
  };
  return {
    read,
    async saveSettings(ownerId, settings, now) {
      const old = await read(ownerId);
      await collection().updateOne(
        { _id: ownerId, ownerId },
        {
          $set: {
            settings,
            nextRunAt: nextMailRun(settings, now) ?? '',
            ...(settings.enabled && !old?.enabledAt && { enabledAt: now.toISOString() }),
          },
          $inc: { revision: 1 },
          $setOnInsert: { ownerId },
          $unset: { leaseToken: '', leaseUntil: '' },
        },
        { upsert: true },
      );
    },
    async pause(ownerId) {
      await collection().updateOne(
        { _id: ownerId, ownerId },
        {
          $set: { 'settings.enabled': false, nextRunAt: '' },
          $inc: { revision: 1 },
          $unset: { leaseToken: '', leaseUntil: '' },
        },
      );
    },
    async purge(ownerId) {
      await collection().deleteOne({ _id: ownerId, ownerId });
      await operations().deleteMany({ ownerId });
    },
    async due(now) {
      const rows = await collection()
        .find(
          {
            'settings.enabled': true,
            'settings.mode': 'scheduled',
            $and: [
              {
                $or: [
                  { nextRunAt: { $lte: now.toISOString() } },
                  { nextRunAt: { $exists: false } },
                ],
              },
              { $or: [{ leaseToken: { $exists: false } }, { leaseUntil: { $lt: now } }] },
            ],
          },
          { projection: { ownerId: 1 } },
        )
        .sort({ nextRunAt: 1, _id: 1 })
        .limit(20)
        .toArray();
      return rows.map((row) => row.ownerId);
    },
    async prune(now) {
      await collection().updateMany({}, [
        {
          $set: {
            results: {
              $arrayToObject: {
                $filter: {
                  input: { $objectToArray: { $ifNull: ['$results', {}] } },
                  as: 'item',
                  cond: { $gte: ['$$item.v.updatedAt', new Date(now.getTime() - 30 * 86400_000)] },
                },
              },
            },
          },
        },
      ]);
    },
    async claim(ownerId, token, now) {
      const row = await collection().findOneAndUpdate(
        {
          _id: ownerId,
          ownerId,
          'settings.enabled': true,
          $or: [{ leaseToken: { $exists: false } }, { leaseUntil: { $lt: now } }],
        },
        {
          $set: { leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000), lastError: '' },
        },
        { returnDocument: 'after' },
      );
      if (!row) return null;
      const cutoff = now.getTime() - 30 * 86400_000;
      const stale = Object.entries(row.results ?? {})
        .sort(([, a], [, b]) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .filter(([, value], index) => index >= 200 || new Date(value.updatedAt).getTime() < cutoff);
      if (stale.length)
        await collection().updateOne(
          { _id: ownerId, ownerId, leaseToken: token },
          {
            $unset: Object.fromEntries(stale.map(([key]) => [`results.${key}`, ''])),
          },
        );
      return decode(row);
    },
    async update(ownerId, token, fields) {
      return (
        (
          await collection().updateOne(
            { _id: ownerId, ownerId, leaseToken: token, 'settings.enabled': true },
            { $set: fieldsFor(ownerId, fields) },
          )
        ).matchedCount === 1
      );
    },
    async release(ownerId, token, fields) {
      await collection().updateOne(
        { _id: ownerId, ownerId, leaseToken: token },
        {
          $set: fieldsFor(ownerId, fields),
          $unset: { leaseToken: '', leaseUntil: '' },
        },
      );
    },
    async results(ownerId) {
      const row = await collection().findOne(
        { _id: ownerId, ownerId },
        { projection: { results: 1 } },
      );
      const cutoff = Date.now() - 30 * 86400_000;
      return Object.entries(row?.results ?? {})
        .filter(([, value]) => new Date(value.updatedAt).getTime() >= cutoff)
        .sort(([, a], [, b]) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 200)
        .map(([id, result]) =>
          codec.open<StoredMailResult>(ownerId, `result:${id}`, result.encrypted),
        );
    },
    async result(ownerId, id) {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      const row = await collection().findOne(
        { _id: ownerId, ownerId },
        { projection: { [`results.${id}`]: 1 } },
      );
      const result = row?.results?.[id];
      return result
        ? codec.open<StoredMailResult>(ownerId, `result:${id}`, result.encrypted)
        : null;
    },
    async putResult(ownerId, token, result) {
      if (!/^[a-f0-9]{64}$/.test(result.id)) throw new Error('Ungültiger Mail-Vorgang.');
      const write = await collection().updateOne(
        { _id: ownerId, ownerId, leaseToken: token, 'settings.enabled': true },
        [
          {
            $set: {
              [`results.${result.id}`]: {
                $literal: {
                  encrypted: codec.seal(ownerId, `result:${result.id}`, result),
                  updatedAt: new Date(),
                },
              },
            },
          },
          {
            $set: {
              results: {
                $arrayToObject: {
                  $slice: [
                    {
                      $sortArray: {
                        input: { $objectToArray: '$results' },
                        sortBy: { 'v.updatedAt': -1, k: 1 },
                      },
                    },
                    200,
                  ],
                },
              },
            },
          },
        ],
      );
      if (!write.matchedCount) throw new Error('Die persönliche Verarbeitung wurde angehalten.');
    },
    async draftState(ownerId, conversationKey) {
      const row = await operations().findOne({ _id: conversationKey, ownerId });
      return row ? { sourceHash: row.sourceHash, state: row.state } : null;
    },
    async reserveDraft(ownerId, token, conversationKey, sourceHash) {
      const lease = { _id: ownerId, ownerId, leaseToken: token, 'settings.enabled': true };
      const finishReservation = async (): Promise<boolean> => {
        if (await collection().findOne(lease)) return true;
        // A disconnect may purge both collections between the lease read and reservation write.
        await operations().deleteOne({
          _id: conversationKey,
          ownerId,
          sourceHash,
          state: 'pending',
          reservationToken: token,
        });
        return false;
      };
      if (!(await collection().findOne(lease))) return false;
      const old = await operations().findOne({ _id: conversationKey, ownerId });
      if (old?.state === 'pending' || old?.sourceHash === sourceHash) return false;
      if (old) {
        const reserved =
          (
            await operations().updateOne(
              { _id: conversationKey, ownerId, sourceHash: old.sourceHash, state: old.state },
              { $set: { sourceHash, state: 'pending', reservationToken: token } },
            )
          ).modifiedCount === 1;
        return reserved && (await finishReservation());
      }
      try {
        await operations().insertOne({
          _id: conversationKey,
          ownerId,
          sourceHash,
          state: 'pending',
          reservationToken: token,
        });
        return await finishReservation();
      } catch (error) {
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
      }
    },
    async finishDraft(ownerId, conversationKey, sourceHash, state) {
      await operations().updateOne(
        { _id: conversationKey, ownerId, sourceHash, state: 'pending' },
        { $set: { state } },
      );
    },
  };
}
