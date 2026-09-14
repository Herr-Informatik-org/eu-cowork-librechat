import type { Collection, Document } from 'mongodb';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import type { BrainCandidate } from './session';
import { createHash } from 'node:crypto';
import { BrainHistoryError } from './history';

export interface BrainHistoryCursor {
  createdAt: Date;
  messageId: string;
}

export interface BrainHistoryMessage extends BrainHistoryCursor {
  conversationId: string;
  text: string;
}

export interface BrainHistoryPending {
  message: BrainHistoryCursor & { conversationId: string };
  sourceHash: string;
  offset: number;
  end: number;
  saved: number;
  facts?: BrainCandidate[];
  billing?: 'started' | 'complete';
}

export interface BrainHistoryJob {
  _id: string;
  ownerId: string;
  status: BrainHistoryStatus['status'];
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  revision: number;
  cutoff: Date;
  cursor?: BrainHistoryCursor;
  pending?: BrainHistoryPending;
  leaseToken?: string;
  leaseUntil?: Date;
  pauseRequested?: boolean;
  error?: string;
  modelLabel?: string;
}

export interface BrainHistoryStore {
  read(ownerId: string): Promise<BrainHistoryJob | null>;
  create(job: BrainHistoryJob): Promise<void>;
  claim(
    ownerId: string,
    revision: number,
    token: string,
    until: Date,
  ): Promise<BrainHistoryJob | null>;
  update(ownerId: string, token: string, fields: Partial<BrainHistoryJob>): Promise<boolean>;
  pause(ownerId: string): Promise<void>;
  expire(ownerId: string, now: Date, error: string): Promise<void>;
  count(ownerId: string, cursor: BrainHistoryCursor | undefined, cutoff: Date): Promise<number>;
  next(
    ownerId: string,
    cursor: BrainHistoryCursor | undefined,
    cutoff: Date,
  ): Promise<BrainHistoryMessage | null>;
  source(
    ownerId: string,
    messageId: string,
    conversationId: string,
  ): Promise<BrainHistoryMessage | null>;
}

/** Every source query checks both message ownership and the still-existing personal conversation. */
export function brainHistorySourcePipeline(ownerId: string, filter: Document = {}): Document[] {
  return [
    {
      $match: {
        user: ownerId,
        isCreatedByUser: true,
        isTemporary: { $ne: true },
        addedConvo: { $ne: true },
        expiredAt: null,
        ...filter,
      },
    },
    {
      $lookup: {
        from: 'conversations',
        let: { conversationId: '$conversationId' },
        pipeline: [
          {
            $match: {
              user: ownerId,
              isTemporary: { $ne: true },
              expiredAt: null,
              $expr: { $eq: ['$conversationId', '$$conversationId'] },
            },
          },
          { $limit: 1 },
        ],
        as: 'ownedConversation',
      },
    },
    { $match: { 'ownedConversation.0': { $exists: true } } },
  ];
}

function cursorFilter(cursor: BrainHistoryCursor | undefined, cutoff: Date): Document {
  return {
    createdAt: { $lte: cutoff },
    ...(cursor
      ? {
          $or: [
            { createdAt: { $gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, messageId: { $gt: cursor.messageId } },
          ],
        }
      : {}),
  };
}

/** Raw Mongo collections avoid a schema migration; the only upsert is the initial authenticated start. */
export function createMongoBrainHistoryStore({
  jobs,
  messages,
  tombstones,
}: {
  jobs: () => Collection<BrainHistoryJob>;
  messages: () => Collection;
  tombstones: () => Collection<{ ownerId: string; key: string; deletedAt: string }>;
}): BrainHistoryStore {
  let indexReady: Promise<string> | undefined;
  const allowed = async (ownerId: string, source: BrainHistoryMessage) => {
    const key = (kind: string, value: string) =>
      `${kind}:${createHash('sha256').update(value).digest('hex')}`;
    const sources = await tombstones()
      .find({
        ownerId,
        key: {
          $in: [
            'user',
            key('conversation', source.conversationId),
            key(
              'source',
              `chat:${encodeURIComponent(source.conversationId)}:${encodeURIComponent(source.messageId)}`,
            ),
          ],
        },
      })
      .toArray();
    return !sources.some(
      (stone) =>
        stone.key !== 'user' || new Date(source.createdAt).getTime() <= Date.parse(stone.deletedAt),
    );
  };
  return {
    read: (ownerId) => jobs().findOne({ _id: ownerId, ownerId }),
    async create(job) {
      const userDeleted = () => tombstones().findOne({ ownerId: job.ownerId, key: 'user' });
      if (await userDeleted())
        throw new BrainHistoryError(
          'Das Benutzerkonto wird gelöscht. Ein Import kann nicht mehr gestartet werden.',
        );
      indexReady ??= messages()
        .createIndex(
          { user: 1, isCreatedByUser: 1, createdAt: 1, messageId: 1 },
          { name: 'brain_history_owner_cursor' },
        )
        .catch((error) => {
          indexReady = undefined;
          throw error;
        });
      await indexReady;
      await jobs().updateOne(
        { _id: job._id, ownerId: job.ownerId },
        { $setOnInsert: job },
        { upsert: true },
      );
      if (await userDeleted()) {
        await jobs().deleteOne({ _id: job._id, ownerId: job.ownerId });
        throw new BrainHistoryError('Das Benutzerkonto wird gelöscht. Der Import wurde beendet.');
      }
    },
    async claim(ownerId, revision, token, until) {
      return jobs().findOneAndUpdate(
        { _id: ownerId, ownerId, revision, status: { $ne: 'running' } },
        {
          $set: { status: 'running', leaseToken: token, leaseUntil: until, pauseRequested: false },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
    },
    async update(ownerId, token, fields) {
      const set: Document = {};
      const unset: Document = {};
      for (const [key, value] of Object.entries(fields)) {
        if (['_id', 'ownerId', 'revision', 'leaseToken'].includes(key)) continue;
        if (value === undefined) unset[key] = '';
        else set[key] = value;
      }
      const result = await jobs().updateOne(
        { _id: ownerId, ownerId, leaseToken: token, status: 'running' },
        {
          $set: set,
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $inc: { revision: 1 },
        },
      );
      return result.matchedCount === 1;
    },
    async pause(ownerId) {
      await jobs().updateOne(
        { _id: ownerId, ownerId, status: 'running' },
        { $set: { pauseRequested: true }, $inc: { revision: 1 } },
      );
    },
    async expire(ownerId, now, error) {
      await jobs().updateOne(
        { _id: ownerId, ownerId, status: 'running', leaseUntil: { $lte: now } },
        {
          $set: { status: 'paused', error },
          $inc: { revision: 1 },
          $unset: { leaseToken: '', leaseUntil: '' },
        },
      );
    },
    async count(ownerId, cursor, cutoff) {
      const [result] = await messages()
        .aggregate<{ total: number }>([
          ...brainHistorySourcePipeline(ownerId, cursorFilter(cursor, cutoff)),
          { $count: 'total' },
        ])
        .toArray();
      return result?.total ?? 0;
    },
    async next(ownerId, cursor, cutoff) {
      let position = cursor;
      while (true) {
        const [match, ...owned] = brainHistorySourcePipeline(
          ownerId,
          cursorFilter(position, cutoff),
        );
        const batch = await messages()
          .aggregate<BrainHistoryMessage>([
            match,
            { $sort: { createdAt: 1, messageId: 1 } },
            ...owned,
            { $limit: 25 },
            {
              $project: {
                _id: 0,
                messageId: 1,
                conversationId: 1,
                createdAt: 1,
                text: { $ifNull: ['$text', ''] },
              },
            },
          ])
          .toArray();
        for (const source of batch) if (await allowed(ownerId, source)) return source;
        if (batch.length < 25) return null;
        position = batch[batch.length - 1];
      }
    },
    async source(ownerId, messageId, conversationId) {
      const [result] = await messages()
        .aggregate<BrainHistoryMessage>([
          ...brainHistorySourcePipeline(ownerId, { messageId, conversationId }),
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              messageId: 1,
              conversationId: 1,
              createdAt: 1,
              text: { $ifNull: ['$text', ''] },
            },
          },
        ])
        .toArray();
      return result && (await allowed(ownerId, result)) ? result : null;
    },
  };
}
