import type { Collection, Document } from 'mongodb';
import { createOpsStore } from './store';
import { readOpsConfig } from './config';
type Row = { _id: string; [key: string]: unknown };
type Change = {
  $set?: Partial<Row>;
  $setOnInsert?: Partial<Row>;
  $inc?: Record<string, number>;
  $pull?: { leases: { id: string } };
};
function memory() {
  const documents = new Map<string, Row[]>();
  const collection = <T extends Document>(name: string): Collection<T> => {
    if (!documents.has(name)) documents.set(name, []);
    const rows = documents.get(name)!;
    const matches = (row: Row, filter: Partial<Row>) =>
      Object.entries(filter).every(([field, value]) => row[field] === value);
    const update = (filter: Partial<Row>, change: Change, options?: { upsert?: boolean }) => {
      let row = rows.find((entry) => matches(entry, filter));
      if (!row && options?.upsert) {
        row = { _id: String(filter._id), ...change.$setOnInsert };
        rows.push(row);
      }
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, change.$set);
      for (const [key, value] of Object.entries(change.$inc ?? {}))
        row[key] = Number(row[key] ?? 0) + value;
      if (change.$pull)
        row.leases = (row.leases as { id: string }[]).filter(
          (lease) => lease.id !== change.$pull!.leases.id,
        );
      return { matchedCount: 1, modifiedCount: 1 };
    };
    return {
      createIndex: async () => 'expiresAt_1',
      insertOne: async (row: Row) => {
        rows.push(structuredClone(row));
      },
      countDocuments: async (filter: Partial<Row>) =>
        rows.filter((entry) => matches(entry, filter)).length,
      findOne: async (filter: Partial<Row>) =>
        structuredClone(rows.find((entry) => matches(entry, filter)) ?? null),
      updateOne: async (filter: Partial<Row>, change: Change, options?: { upsert?: boolean }) =>
        update(filter, change, options),
      findOneAndUpdate: async (filter: Partial<Row>, change: Change) => {
        const row = rows.find((entry) => matches(entry, filter));
        if (!row) return null;
        update(filter, change);
        return structuredClone(row);
      },
      find: (filter: Partial<Row>) => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => structuredClone(rows.filter((entry) => matches(entry, filter))),
          }),
        }),
      }),
    } as unknown as Collection<T>;
  };
  return { documents, collection };
}
describe('OPS key and atomic quota store', () => {
  test('stores only hash; rotates and revokes immediately', async () => {
    const state = memory();
    const store = createOpsStore(state.collection);
    const issued = await store.create({ name: 'OPS', modules: ['mail', 'netdoc'] });
    expect(JSON.stringify([...state.documents])).not.toContain(issued.key);
    expect((await store.list())[0]).not.toHaveProperty('hash');
    const original = await store.authorize(`Bearer ${issued.key}`, 'mail');
    await expect(store.authorize(`Bearer ${issued.key}`, 'other')).rejects.toMatchObject({
      status: 403,
    });
    const rotated = await store.rotate(issued.record.id);
    await expect(store.active(original)).rejects.toMatchObject({ status: 401 });
    await expect(store.authorize(`Bearer ${issued.key}`, 'mail')).rejects.toMatchObject({
      status: 401,
    });
    const fresh = await store.authorize(`Bearer ${rotated.key}`, 'mail');
    await store.revoke(issued.record.id);
    await expect(store.active(fresh)).rejects.toMatchObject({ status: 401 });
  });
  test('module metadata never acts as key identity', async () => {
    const store = createOpsStore(memory().collection);
    await expect(store.authorize(undefined, 'mail')).rejects.toMatchObject({ status: 401 });
    await expect(store.authorize('Bearer arbitrary', 'mail')).rejects.toMatchObject({
      status: 401,
    });
  });
  test('CAS enforces per-key and global concurrency under racing requests', async () => {
    const store = createOpsStore(memory().collection);
    const limits = { ...readOpsConfig({}).limits, parallel: 2, globalParallel: 3 };
    const race = await Promise.allSettled(
      Array.from({ length: 5 }, () => store.reserve('key1', limits)),
    );
    expect(race.filter((entry) => entry.status === 'fulfilled')).toHaveLength(2);
    const other = await store.reserve('key2', limits);
    await expect(store.reserve('key3', limits)).rejects.toMatchObject({ status: 429 });
    await other();
    for (const entry of race) if (entry.status === 'fulfilled') await entry.value();
    await expect(store.reserve('key3', limits)).resolves.toBeInstanceOf(Function);
  });
  test('rate counts survive release and abandoned leases expire', async () => {
    let time = 1000;
    const store = createOpsStore(memory().collection, () => time);
    const limits = { ...readOpsConfig({}).limits, rpm: 1, timeoutMs: 1000 };
    await (
      await store.reserve('a', limits)
    )();
    await expect(store.reserve('a', limits)).rejects.toMatchObject({ status: 429, retryAfter: 60 });
    time += 60001;
    await expect(store.reserve('a', limits)).resolves.toBeInstanceOf(Function);
    time += 60001;
    await expect(store.reserve('a', limits)).resolves.toBeInstanceOf(Function);
  });
  test('metering persists only counts and labels', async () => {
    const state = memory();
    const store = createOpsStore(state.collection);
    await store.meter({
      key: 'key1',
      module: 'mail',
      model: 'test-model',
      input: 30,
      output: 10,
      durationMs: 42,
      status: 'success',
      errorCode: null,
    });
    const row = state.documents.get('eucowork_ops_llm_usage')![0];
    expect(Object.keys(row).sort()).toEqual([
      '_id',
      'at',
      'durationMs',
      'errorCode',
      'expiresAt',
      'input',
      'key',
      'model',
      'module',
      'output',
      'status',
    ]);
    expect(row).toMatchObject({ status: 'success', input: 30, output: 10, durationMs: 42 });
  });
});
