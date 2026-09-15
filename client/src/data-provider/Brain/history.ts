import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import { useGetUserQuery } from '../Auth';
import { refreshBrainGraph } from './cache';

export function useBrainHistory(enabled: boolean) {
  const { data: user } = useGetUserQuery();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.brain, userId, 'history'];
  const previous = useRef<{ userId: string; status: BrainHistoryStatus }>();

  const observeStatus = (status: BrainHistoryStatus) => {
    if (!userId) return;
    const before = previous.current?.userId === userId ? previous.current.status : undefined;
    previous.current = { userId, status };
    if (
      status.saved > (before?.saved ?? 0) ||
      (before?.status === 'running' && status.status !== 'running')
    ) {
      if (!(status.status === 'completed' && status.autoActivate))
        void refreshBrainGraph(
          queryClient,
          userId,
          status.schemaVersion === 2 ? status.rebuildId : undefined,
        );
      if (status.status === 'completed') void refreshBrainGraph(queryClient, userId);
    }
    if (before && (before.status !== status.status || before.rebuildId !== status.rebuildId))
      void queryClient.invalidateQueries([QueryKeys.brain, userId, 'rebuild']);
  };

  const history = useQuery(queryKey, ({ signal }) => dataService.getBrainHistory(signal), {
    enabled: enabled && !!userId,
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: (status) => (status?.status === 'running' ? 2000 : false),
    onSuccess: observeStatus,
  });

  const options = {
    onMutate: () => queryClient.cancelQueries(queryKey),
    onSuccess: async (status: BrainHistoryStatus) => {
      // Focus or polling may have started another read while the mutation was pending.
      await queryClient.cancelQueries(queryKey);
      queryClient.setQueryData(queryKey, status);
      observeStatus(status);
    },
    onError: () => {
      // A lost response does not establish whether the server accepted the action.
      void queryClient.invalidateQueries(queryKey);
    },
  };
  const start = useMutation(
    [MutationKeys.startBrainHistory, userId],
    () => {
      if (!enabled || !userId) throw new Error('Authentication and memory permissions required');
      return dataService.startBrainHistory();
    },
    options,
  );
  const pause = useMutation(
    [MutationKeys.pauseBrainHistory, userId],
    () => {
      if (!enabled || !userId) throw new Error('Authentication and memory permissions required');
      return dataService.pauseBrainHistory();
    },
    options,
  );
  return { history, start, pause };
}
