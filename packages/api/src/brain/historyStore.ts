import type { Collection, Document } from 'mongodb';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import type { BrainCandidate } from './session';
import { createHash } from 'node:crypto';
import { BrainHistoryError } from './history';
import type { BrainConversationMessage, BrainStoredMessage } from './conversation';
import type { BrainReviewCheckpoint } from './review';
import { conversationMessages, conversationTranscript } from './conversation';

export interface BrainHistoryCursor {
  createdAt: Date;
  messageId: string;
}

export interface BrainHistoryMessage extends BrainHistoryCursor {
  conversationId: string;
  text: string;
  messages?: BrainConversationMessage[];
}

export interface BrainHistoryPending {
  message: BrainHistoryCursor & { conversationId: string };
  sourceHash: string;
  offset: number;
  end: number;
  saved: number;
  facts?: BrainCandidate[];
  billing?: 'started' | 'complete';
  review?: BrainReviewCheckpoint;
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
  errorCode?: string;
  incidentId?: string;
  modelLabel?: string;
  schemaVersion?: 2;
  rebuildId?: string;
  analysisFingerprint?: string;
  processedSections?: number;
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
  pause(ownerId: string, rebuildId?: string): Promise<void>;
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
  resetConversationJob?(job: BrainHistoryJob): Promise<void>;
  countConversations?(
    ownerId: string,
    cursor: BrainHistoryCursor | undefined,
    cutoff: Date,
  ): Promise<number>;
  nextConversation?(
    ownerId: string,
    cursor: BrainHistoryCursor | undefined,
    cutoff: Date,
  ): Promise<BrainHistoryMessage | null>;
  conversation?(
    ownerId: string,
    conversationId: string,
    cutoff: Date,
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
  const conversationPipeline = (
    ownerId: string,
    cursor: BrainHistoryCursor | undefined,
    cutoff: Date,
  ): Document[] => [
    ...brainHistorySourcePipeline(ownerId, { createdAt: { $lte: cutoff } }),
    { $group: { _id: '$conversationId', createdAt: { $min: '$createdAt' } } },
    { $project: { _id: 0, conversationId: '$_id', messageId: '$_id', createdAt: 1 } },
    { $match: cursorFilter(cursor, cutoff) },
    { $sort: { createdAt: 1, messageId: 1 } },
  ];
  const conversation = async (
    ownerId: string,
    conversationId: string,
    cutoff: Date,
  ): Promise<BrainHistoryMessage | null> => {
    const records = await messages()
      .aggregate<BrainStoredMessage>([
        ...brainHistorySourcePipeline(ownerId, {
          conversationId,
          isCreatedByUser: { $in: [true, false] },
          createdAt: { $lte: cutoff },
        }),
        {
          $project: {
            _id: 0,
            messageId: 1,
            conversationId: 1,
            text: 1,
            content: 1,
            parentMessageId: 1,
            isCreatedByUser: 1,
            createdAt: 1,
            unfinished: 1,
            error: 1,
          },
        },
        { $sort: { createdAt: 1, messageId: 1 } },
      ])
      .toArray();
    if (!records.length) return null;
    const key = (kind: string, value: string) =>
      `${kind}:${createHash('sha256').update(value).digest('hex')}`;
    const stones = await tombstones()
      .find({
        ownerId,
        key: {
          $in: [
            'user',
            key('conversation', conversationId),
            ...records.map((message) =>
              key(
                'source',
                `chat:${encodeURIComponent(conversationId)}:${encodeURIComponent(message.messageId)}`,
              ),
            ),
          ],
        },
      })
      .toArray();
    const blocked = new Map(stones.map((stone) => [stone.key, stone.deletedAt]));
    if (blocked.has(key('conversation', conversationId))) return null;
    const eligible = records.filter(
      (message) =>
        !blocked.has(
          key(
            'source',
            `chat:${encodeURIComponent(conversationId)}:${encodeURIComponent(message.messageId)}`,
          ),
        ) &&
        (!blocked.has('user') || new Date(message.createdAt).toISOString() > blocked.get('user')!),
    );
    const transcript = conversationMessages(eligible);
    if (!transcript.some((message) => message.role === 'user')) return null;
    const createdAt = new Date(
      records
        .filter((message) => message.isCreatedByUser)
        .reduce(
          (first, message) => Math.min(first, new Date(message.createdAt).getTime()),
          Infinity,
        ),
    );
    return {
      messageId: conversationId,
      conversationId,
      createdAt,
      messages: transcript,
      text: conversationTranscript(transcript),
    };
  };
  return {
    async resetConversationJob(job) {
      if (await tombstones().findOne({ ownerId: job.ownerId, key: 'user' }))
        throw new BrainHistoryError(
          'Das Benutzerkonto wird gelöscht. Ein Neuaufbau ist nicht möglich.',
        );
      // A retry for the same draft must never replace its live lease or checkpoints.
      const existing = await jobs().findOne({ _id: job.ownerId, ownerId: job.ownerId });
      if (existing?.schemaVersion === 2 && existing.rebuildId === job.rebuildId) return;
      if (existing) {
        const result = await jobs().replaceOne(
          { _id: job.ownerId, ownerId: job.ownerId, revision: existing.revision },
          job,
        );
        if (!result.matchedCount) {
          const current = await jobs().findOne({ _id: job.ownerId, ownerId: job.ownerId });
          if (current?.schemaVersion === 2 && current.rebuildId === job.rebuildId) return;
          throw new BrainHistoryError(
            'Der Import wurde zwischenzeitlich geändert. Bitte erneut versuchen.',
          );
        }
      } else {
        try {
          await jobs().insertOne(job);
        } catch (error) {
          const current = await jobs().findOne({ _id: job.ownerId, ownerId: job.ownerId });
          if (current?.schemaVersion === 2 && current.rebuildId === job.rebuildId) return;
          throw error;
        }
      }
      if (await tombstones().findOne({ ownerId: job.ownerId, key: 'user' })) {
        await jobs().deleteOne({ _id: job.ownerId, ownerId: job.ownerId });
        throw new BrainHistoryError(
          'Das Benutzerkonto wird gelöscht. Ein Neuaufbau ist nicht möglich.',
        );
      }
    },
    async countConversations(ownerId, cursor, cutoff) {
      const [result] = await messages()
        .aggregate<{ total: number }>([
          ...conversationPipeline(ownerId, cursor, cutoff),
          { $count: 'total' },
        ])
        .toArray();
      return result?.total ?? 0;
    },
    async nextConversation(ownerId, cursor, cutoff) {
      let position = cursor;
      while (true) {
        const batch = await messages()
          .aggregate<BrainHistoryMessage>([
            ...conversationPipeline(ownerId, position, cutoff),
            { $limit: 25 },
          ])
          .toArray();
        for (const entry of batch) {
          const source = await conversation(ownerId, entry.conversationId, cutoff);
          if (source) return { ...source, createdAt: entry.createdAt };
        }
        if (batch.length < 25) return null;
        position = batch[batch.length - 1];
      }
    },
    conversation,
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
    async pause(ownerId, rebuildId) {
      await jobs().updateOne(
        { _id: ownerId, ownerId, status: 'running', ...(rebuildId ? { rebuildId } : {}) },
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
