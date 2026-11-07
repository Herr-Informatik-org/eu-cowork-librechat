import { BSON } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import type {
  MailCheckpoint,
  MailHistoryCheckpoint,
  MailJob,
  MailStore,
  StoredMailResult,
  StoredMailMoveJob,
} from './types';
import type { MailCodec } from './privateData';
import { nextMailRun, mailHistoryStart } from './schedule';
import { MAIL_CONSENT_VERSION } from './types';
import { activeMoveJob, summarizeMove } from './moves';
import { normalizeMailSignature } from './signature';
import type { MailSignature } from './types';

interface Row extends Omit<MailJob, 'checkpoint' | 'history'> {
  _id: string;
  checkpointEncrypted?: string;
  signatureEncrypted?: string;
  historyEncrypted?: string;
  results?: Record<string, { encrypted: string; updatedAt: Date }>;
  moveJobsEncrypted?: string;
  moveQueueVersion?: number;
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
    const {
      checkpointEncrypted,
      signatureEncrypted,
      historyEncrypted,
      results: _results,
      _id: _id,
      moveJobsEncrypted: _moves,
      moveQueueVersion: _moveVersion,
      ...job
    } = row;
    return {
      ...job,
      settings: {
        ...job.settings,
        ...(signatureEncrypted && {
          signature: normalizeMailSignature(
            codec.open<MailSignature>(row.ownerId, 'signature', signatureEncrypted),
          ),
        }),
      },
      ...(checkpointEncrypted && {
        checkpoint: codec.open<MailCheckpoint>(row.ownerId, 'checkpoint', checkpointEncrypted),
      }),
      ...(historyEncrypted && {
        history: codec.open<MailHistoryCheckpoint>(
          row.ownerId,
          'history-checkpoint',
          historyEncrypted,
        ),
      }),
    };
  };
  const fieldsFor = (owner: string, fields: Partial<MailJob>): Document => {
    const result: Document = {};
    for (const name of [
      'lastRunAt',
      'nextRunAt',
      'lastError',
      'leaseUntil',
      'continuation',
    ] as const) {
      if (fields[name] !== undefined) result[name] = fields[name];
    }
    if (fields.checkpoint)
      result.checkpointEncrypted = codec.seal(owner, 'checkpoint', fields.checkpoint);
    if (fields.history)
      result.historyEncrypted = codec.seal(owner, 'history-checkpoint', fields.history);
    return result;
  };
  const read = async (owner: string) => {
    const row = await collection().findOne({ _id: owner, ownerId: owner });
    return row ? decode(row) : null;
  };
  const decodedMoves = (row: Row): StoredMailMoveJob[] =>
    row.moveJobsEncrypted
      ? codec.open<StoredMailMoveJob[]>(row.ownerId, 'move-jobs', row.moveJobsEncrypted)
      : [];
  const queueVersion = (row: Row) => row.moveQueueVersion ?? { $exists: false };
  const queueFields = (owner: string, jobs: StoredMailMoveJob[]) => ({
    moveJobsEncrypted: codec.seal(owner, 'move-jobs', jobs),
    movePending: jobs.some(activeMoveJob),
  });
  return {
    read,
    async moveJobs(ownerId) {
      const row = await collection().findOne({ _id: ownerId, ownerId });
      return row ? decodedMoves(row) : [];
    },
    async enqueueMove(ownerId, job) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await collection().findOne({ _id: ownerId, ownerId });
        if (
          !row ||
          row.revision !== job.settingsRevision ||
          row.settings.consentVersion !== MAIL_CONSENT_VERSION
        )
          return 'revoked';
        const jobs = decodedMoves(row);
        const previous = jobs.find((item) => item.id === job.id);
        if (previous) return previous.requestHash === job.requestHash ? 'duplicate' : 'busy';
        if (jobs.some(activeMoveJob)) return 'busy';
        const cutoff = Date.parse(job.createdAt) - 30 * 86400_000;
        const retained = jobs.filter((item) => Date.parse(item.updatedAt) >= cutoff).slice(-4);
        const fields = queueFields(ownerId, [...retained, job]);
        if (BSON.calculateObjectSize({ ...row, ...fields }) > 13 * 1024 * 1024) return 'busy';
        const saved = await collection().updateOne(
          {
            _id: ownerId,
            ownerId,
            revision: job.settingsRevision,
            moveQueueVersion: queueVersion(row),
          },
          { $set: fields, $inc: { moveQueueVersion: 1 } },
        );
        if (saved.matchedCount) return 'accepted';
      }
      return 'busy';
    },
    async updateMove(ownerId, token, job) {
      const binding = { _id: ownerId, ownerId, leaseToken: token, revision: job.settingsRevision };
      const row = await collection().findOne(binding);
      if (!row) return false;
      const jobs = decodedMoves(row);
      if (!jobs.some((item) => item.id === job.id && activeMoveJob(item))) return false;
      const saved = await collection().updateOne(
        { ...binding, moveQueueVersion: queueVersion(row) },
        {
          $set: queueFields(
            ownerId,
            jobs.map((item) => (item.id === job.id ? job : item)),
          ),
          $inc: { moveQueueVersion: 1 },
        },
      );
      return saved.matchedCount === 1;
    },
    async cancelStaleMoves(ownerId, now, jobId) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await collection().findOne({ _id: ownerId, ownerId });
        if (!row?.movePending) return;
        const jobs = decodedMoves(row);
        let changed = false;
        const cancelled = jobs.map((job) => {
          if (
            !activeMoveJob(job) ||
            (job.id !== jobId &&
              job.settingsRevision === row.revision &&
              row.settings.consentVersion === MAIL_CONSENT_VERSION)
          )
            return job;
          changed = true;
          return summarizeMove(
            {
              ...job,
              items: job.items.map((item) => {
                if (item.status === 'queued')
                  return {
                    ...item,
                    status: 'cancelled' as const,
                    error:
                      'Durch Pausieren, geänderte Freigabe oder Verbindung abgebrochen. Bitte neu auswählen.',
                  };
                if (item.status === 'running')
                  return {
                    ...item,
                    status: 'uncertain' as const,
                    error:
                      'Während der Bearbeitung angehalten. Bitte die Ablage in Outlook prüfen; keine automatische Wiederholung.',
                  };
                return item;
              }),
            },
            now,
          );
        });
        if (!changed) return;
        const saved = await collection().updateOne(
          { _id: ownerId, ownerId, revision: row.revision, moveQueueVersion: queueVersion(row) },
          { $set: queueFields(ownerId, cancelled), $inc: { moveQueueVersion: 1 } },
        );
        if (saved.matchedCount) return;
      }
    },
    async movesDue(now) {
      const rows = await collection()
        .find(
          {
            movePending: true,
            $or: [{ leaseToken: { $exists: false } }, { leaseUntil: { $lt: now } }],
          },
          { projection: { ownerId: 1 } },
        )
        .sort({ _id: 1 })
        .limit(20)
        .toArray();
      return rows.map((row) => row.ownerId);
    },
    async saveSettings(ownerId, settings, now) {
      let observedExisting = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const old = await read(ownerId);
        if (!old && observedExisting)
          throw Error('Die persönliche Verbindung wurde während des Speicherns getrennt.');
        observedExisting ||= !!old;
        const { signature: requestedSignature, ...plainSettings } = settings;
        const signature =
          requestedSignature === undefined
            ? old?.settings.signature
            : normalizeMailSignature(requestedSignature);
        const selection = settings.history ?? { mode: 'off' };
        const previous = old?.settings.history ?? { mode: 'off' };
        const changed =
          selection.mode !== previous.mode ||
          selection.from !== previous.from ||
          (selection.mode === 'since' && settings.timeZone !== old?.settings.timeZone);
        const until = old?.enabledAt ?? now.toISOString();
        const history: MailHistoryCheckpoint | undefined =
          settings.enabled && selection.mode !== 'off' && (!old?.history || changed)
            ? {
                ...(selection.mode === 'since' && {
                  from: mailHistoryStart(selection.from!, settings.timeZone),
                }),
                until,
                pending: [],
                processed: 0,
                completed: false,
                hasMore: true,
              }
            : undefined;
        try {
          const saved = await collection().updateOne(
            { _id: ownerId, ownerId, revision: old ? old.revision : { $exists: false } },
            {
              $set: {
                settings: plainSettings,
                ...(signature && {
                  signatureEncrypted: codec.seal(ownerId, 'signature', signature),
                }),
                nextRunAt: nextMailRun(settings, now) ?? '',
                ...(settings.enabled && !old?.enabledAt && { enabledAt: until }),
                ...(history && {
                  historyEncrypted: codec.seal(ownerId, 'history-checkpoint', history),
                }),
              },
              $inc: { revision: 1 },
              $setOnInsert: { ownerId },
              $unset: {
                leaseToken: '',
                leaseUntil: '',
                continuation: '',
                ...(!history && (changed || selection.mode === 'off') && { historyEncrypted: '' }),
              },
            },
            { upsert: !old },
          );
          if (saved.matchedCount || saved.upsertedCount) return;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
        }
      }
      throw Error('Die Einstellungen wurden gleichzeitig geändert. Bitte erneut speichern.');
    },
    async pause(ownerId) {
      await collection().updateOne(
        { _id: ownerId, ownerId },
        {
          $set: { 'settings.enabled': false, nextRunAt: '' },
          $inc: { revision: 1 },
          $unset: { leaseToken: '', leaseUntil: '', continuation: '' },
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
            'settings.consentVersion': MAIL_CONSENT_VERSION,
            $and: [
              { $or: [{ 'settings.mode': 'scheduled' }, { 'continuation.mode': 'manual' }] },
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
      await collection().updateMany({ results: { $type: 'object' } }, [
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
      const cutoff = now.getTime() - 30 * 86400_000;
      for await (const row of collection().find({ moveJobsEncrypted: { $exists: true } })) {
        const jobs = decodedMoves(row);
        const retained = jobs.filter((job) => Date.parse(job.updatedAt) >= cutoff);
        if (retained.length === jobs.length) continue;
        await collection().updateOne(
          { _id: row.ownerId, ownerId: row.ownerId, moveQueueVersion: queueVersion(row) },
          { $set: queueFields(row.ownerId, retained), $inc: { moveQueueVersion: 1 } },
        );
      }
    },
    async claim(ownerId, token, now, manual = false, revision) {
      const row = await collection().findOneAndUpdate(
        {
          _id: ownerId,
          ownerId,
          ...(revision !== undefined && { revision }),
          ...(manual
            ? { 'settings.consentVersion': MAIL_CONSENT_VERSION }
            : { 'settings.enabled': true, movePending: { $ne: true } }),
          $or: [{ leaseToken: { $exists: false } }, { leaseUntil: { $lt: now } }],
        },
        {
          $set: {
            leaseToken: token,
            leaseUntil: new Date(now.getTime() + 120_000),
            ...(!manual && { lastError: '' }),
          },
        },
        { returnDocument: 'after' },
      );
      if (!row) return null;
      const cutoff = now.getTime() - 30 * 86400_000;
      const stale = Object.entries(row.results ?? {}).filter(
        ([, value]) => new Date(value.updatedAt).getTime() < cutoff,
      );
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
            { _id: ownerId, ownerId, leaseToken: token },
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
      const binding = { _id: ownerId, ownerId, leaseToken: token };
      const row = await collection().findOne(binding);
      if (!row) throw new Error('Die persönliche Verarbeitung wurde angehalten.');
      const entry = {
        encrypted: codec.seal(ownerId, `result:${result.id}`, result),
        updatedAt: new Date(),
      };
      const proposed = { ...row, results: { ...row.results, [result.id]: entry } };
      // Keep headroom for encrypted cursors and settings; never silently evict visible work.
      if (BSON.calculateObjectSize(proposed) > 12 * 1024 * 1024)
        throw new Error(
          'Der Speicher für Mail-Ergebnisse ist voll. Bitte die Administration informieren.',
        );
      const write = await collection().updateOne(binding, {
        $set: { [`results.${result.id}`]: entry },
      });
      if (!write.matchedCount) throw new Error('Die persönliche Verarbeitung wurde angehalten.');
    },
    async seedResults(ownerId, values) {
      if (values.length > 50 || values.some((value) => !/^[a-f0-9]{64}$/.test(value.id)))
        throw Error('Die Posteingangsseite ist ungültig. Bitte erneut laden.');
      const unique = [...new Map(values.map((value) => [value.id, value])).values()];
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = await collection().findOne({ _id: ownerId, ownerId });
        if (!row) throw Error('Bitte zuerst die persönlichen Mail-Einstellungen speichern.');
        const missing = unique.filter((value) => !row.results?.[value.id]);
        if (!missing.length)
          return unique.map((value) =>
            codec.open<StoredMailResult>(
              ownerId,
              `result:${value.id}`,
              row.results![value.id].encrypted,
            ),
          );
        const additions: Record<string, { encrypted: string; updatedAt: Date }> = {};
        for (const value of missing)
          additions[value.id] = {
            encrypted: codec.seal(ownerId, `result:${value.id}`, value),
            updatedAt: new Date(),
          };
        // The server-side size guard also covers concurrent results from the analysis worker.
        const growth = BSON.calculateObjectSize({ results: additions }) + 1024;
        const saved = await collection().updateOne(
          {
            _id: ownerId,
            ownerId,
            revision: row.revision,
            ...Object.fromEntries(
              missing.map((value) => [`results.${value.id}`, { $exists: false }]),
            ),
            $expr: { $lt: [{ $bsonSize: '$$ROOT' }, 12 * 1024 * 1024 - growth] },
          },
          {
            $set: Object.fromEntries(
              Object.entries(additions).map(([key, value]) => [`results.${key}`, value]),
            ),
          },
        );
        if (!saved.matchedCount && BSON.calculateObjectSize(row) + growth >= 12 * 1024 * 1024)
          throw Error(
            'Die lokale Mailübersicht ist voll. Bitte die Auswahl verkleinern oder den Support kontaktieren.',
          );
        // Re-read after an insert or competing edit; never return stale analysis or overwrite it.
      }
      throw Error('Die Mailübersicht wurde gleichzeitig geändert. Bitte erneut laden.');
    },
    async draftState(ownerId, conversationKey) {
      const row = await operations().findOne({ _id: conversationKey, ownerId });
      return row ? { sourceHash: row.sourceHash, state: row.state } : null;
    },
    async reserveDraft(ownerId, token, conversationKey, sourceHash, retryFailed = false) {
      const lease = { _id: ownerId, ownerId, leaseToken: token };
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
      if (
        old?.state === 'pending' ||
        (old?.sourceHash === sourceHash && !(retryFailed && old.state === 'failed'))
      )
        return false;
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
