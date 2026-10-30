import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useGetUserQuery } from '../Auth';

export function useBrainQuality(enabled: boolean) {
  const { data: user } = useGetUserQuery();
  const ownerId = user?.id;
  const client = useQueryClient();
  const key = [QueryKeys.brain, ownerId, 'quality'];
  const preview = useQuery(key, ({ signal }) => dataService.getBrainQuality(signal), {
    enabled: enabled && !!ownerId,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const prepare = useMutation(
    [...key, 'prepare'],
    ({ revision, findingIds }: { revision: number; findingIds: string[] }) => {
      if (!ownerId || !enabled) throw new Error('Brain ist für diesen Benutzer nicht verfügbar.');
      return dataService.applyBrainQuality(revision, findingIds);
    },
    {
      onMutate: () => ({ ownerId }),
      onSuccess: async (rebuild, _input, context) => {
        if (!context?.ownerId) return;
        const ownerKey = [QueryKeys.brain, context.ownerId];
        await client.cancelQueries(ownerKey);
        client.setQueryData([...ownerKey, 'rebuild'], rebuild);
        await client.invalidateQueries({
          queryKey: ownerKey,
          predicate: (query) => query.queryKey[2] !== 'rebuild',
        });
      },
    },
  );
  return { preview, prepare };
}
