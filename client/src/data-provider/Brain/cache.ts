import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { BrainGraph } from 'librechat-data-provider';

export function brainQueryGeneration(key: QueryKey): string | undefined {
  if (key[2] === 'node') return typeof key[4] === 'string' ? key[4] : undefined;
  const params = key[3];
  if (key[2] === 'graph' && params && typeof params === 'object' && 'generationId' in params)
    return typeof params.generationId === 'string' ? params.generationId : undefined;
  return undefined;
}

/** Inserts invalidate cursors; restart from the first page while keeping its preview visible. */
export async function refreshBrainGraph(
  client: QueryClient,
  userId: string,
  generationId?: string,
) {
  const filter = {
    queryKey: [QueryKeys.brain, userId, 'graph'],
    predicate: (query: { queryKey: QueryKey }) =>
      brainQueryGeneration(query.queryKey) === generationId,
  };
  await client.cancelQueries(filter);
  client.setQueriesData<InfiniteData<BrainGraph>>(filter, (data) =>
    data?.pages ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
  );
  await Promise.all([
    client.invalidateQueries(filter),
    client.invalidateQueries({
      queryKey: [QueryKeys.brain, userId, 'node'],
      predicate: (query) => brainQueryGeneration(query.queryKey) === generationId,
    }),
  ]);
}

/** An activated version must not reuse a cached graph or node from the previous active Brain. */
export async function refreshBrainPointer(client: QueryClient, userId: string) {
  const filter = {
    queryKey: [QueryKeys.brain, userId],
    predicate: (query: { queryKey: QueryKey }) =>
      (query.queryKey[2] === 'graph' || query.queryKey[2] === 'node') &&
      !brainQueryGeneration(query.queryKey),
  };
  await client.cancelQueries(filter);
  await client.resetQueries(filter);
}
