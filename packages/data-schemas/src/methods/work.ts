import type { Connection } from 'mongoose';

const privateCollections = [
  'eucowork_work_outputs',
  'eucowork_work_customers',
  'eucowork_safe_work_tasks',
];

/** Unresolved external effects retain only a blocking tombstone, never private target text. */
export async function deleteOwnedWorkData(
  connection: Connection,
  userId: string,
  conversationIds?: string[],
): Promise<void> {
  const filter = {
    userId,
    ...(conversationIds ? { conversationId: { $in: conversationIds } } : {}),
  };
  await Promise.all(
    privateCollections.map((name) => connection.collection(name).deleteMany(filter)),
  );
  const effects = connection.collection('eucowork_safe_work_effects');
  await effects.deleteMany({ ...filter, state: 'verified' });
  await effects.updateMany(filter, { $unset: { userId: '', conversationId: '', resultEnc: '' } });
  const journal = connection.collection('eucowork_safe_work_records');
  await journal.deleteMany({ ...filter, state: { $in: ['verified', 'claimed'] } });
  await journal.updateMany(filter, {
    $unset: { userId: '', conversationId: '', valuesEnc: '', history: '' },
  });
  if (!conversationIds) {
    await connection.collection('eucowork_work_cost_days').deleteMany({ userId });
    await connection.collection('eucowork_work_cost_calls').deleteMany({ userId });
  }
}

const syncedExpiry = new Map<string, number | null>();
/** Keep archived sources when a temporary chat becomes permanent; shorten them with the chat. */
export async function syncOwnedWorkExpiry(
  connection: Connection,
  userId: string,
  conversationId: string,
  expiresAt: Date | null,
): Promise<void> {
  const key = userId + ':' + conversationId;
  const value = expiresAt?.getTime() ?? null;
  if (syncedExpiry.has(key) && syncedExpiry.get(key) === value) return;
  await Promise.all(
    privateCollections.map((name) =>
      connection
        .collection(name)
        .updateMany(
          { userId, conversationId, expiresAt: { $ne: expiresAt } },
          { $set: { expiresAt } },
        ),
    ),
  );
  syncedExpiry.set(key, value);
  while (syncedExpiry.size > 2000) syncedExpiry.delete(syncedExpiry.keys().next().value!);
}
