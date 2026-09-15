import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type { BrainRebuildStatus } from 'librechat-data-provider';
import { useGetUserQuery } from '../Auth';
import { refreshBrainPointer } from './cache';

export function useBrainRebuild(enabled: boolean, poll = true) {
  const { data: user } = useGetUserQuery();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.brain, userId, 'rebuild'];
  const rebuild = useQuery(
    queryKey,
    async ({ signal }) => {
      const status = await dataService.getBrainRebuild(signal);
      const before = queryClient.getQueryData<BrainRebuildStatus>(queryKey);
      if (
        !signal?.aborted &&
        userId &&
        ((before?.rebuild && !status.rebuild) ||
          (before?.activeGenerationId &&
            status.activeGenerationId &&
            before.activeGenerationId !== status.activeGenerationId))
      )
        await refreshBrainPointer(queryClient, userId);
      return status;
    },
    {
      enabled: enabled && !!userId,
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchInterval: (state) =>
        poll && (state?.rebuild?.status === 'building' || state?.rebuild?.autoActivate)
          ? 2000
          : false,
    },
  );
  const requireOwner = () => {
    if (!enabled || !userId) throw new Error('Brain ist für diesen Benutzer nicht verfügbar.');
    return userId;
  };
  const options = {
    onMutate: async () => {
      const ownerId = requireOwner();
      await queryClient.cancelQueries([QueryKeys.brain, ownerId]);
      return { ownerId };
    },
    onSuccess: async (
      status: BrainRebuildStatus,
      _variables: object | void,
      context?: { ownerId: string },
    ) => {
      if (!context) return;
      const ownerKey = [QueryKeys.brain, context.ownerId];
      await queryClient.cancelQueries(ownerKey);
      const before = queryClient.getQueryData<BrainRebuildStatus>([...ownerKey, 'rebuild']);
      if (before?.rebuild && !status.rebuild)
        await refreshBrainPointer(queryClient, context.ownerId);
      queryClient.setQueryData([...ownerKey, 'rebuild'], status);
      await queryClient.invalidateQueries({
        queryKey: ownerKey,
        predicate: (query) => query.queryKey[2] !== 'rebuild',
      });
    },
    onError: (_error: Error, _variables: object | void, context?: { ownerId: string }) => {
      if (context) void queryClient.invalidateQueries([QueryKeys.brain, context.ownerId]);
    },
  };
  const start = useMutation(
    [MutationKeys.startBrainRebuild, userId],
    () => {
      requireOwner();
      return dataService.startBrainRebuild({ autoActivate: true });
    },
    options,
  );
  const activate = useMutation(
    [MutationKeys.activateBrainRebuild, userId],
    ({ id, revision }: { id: string; revision: number }) => {
      requireOwner();
      return dataService.activateBrainRebuild(id, revision);
    },
    options,
  );
  const discard = useMutation(
    [MutationKeys.discardBrainRebuild, userId],
    ({ id }: { id: string }) => {
      requireOwner();
      return dataService.discardBrainRebuild(id);
    },
    options,
  );
  const rollback = useMutation(
    [MutationKeys.rollbackBrainRebuild, userId],
    () => {
      requireOwner();
      return dataService.rollbackBrainRebuild();
    },
    options,
  );
  return { rebuild, start, activate, discard, rollback };
}
