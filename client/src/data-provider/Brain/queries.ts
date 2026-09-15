import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { BrainGraphParams, BrainNodeInput, BrainNodeUpdate } from 'librechat-data-provider';
import { useGetUserQuery } from '../Auth';

const freshness = { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 };

export function useBrainStatusQuery(enabled = true) {
  const { data: user } = useGetUserQuery();
  return useQuery(
    [QueryKeys.brain, user?.id, 'status'],
    ({ signal }) => dataService.getBrainStatus(signal),
    {
      ...freshness,
      staleTime: 300_000,
      enabled: enabled && !!user?.id,
    },
  );
}

export function useBrainGraphQuery(params: Omit<BrainGraphParams, 'cursor'> = {}, enabled = true) {
  const { data: user } = useGetUserQuery();
  return useInfiniteQuery(
    [QueryKeys.brain, user?.id, 'graph', params],
    ({ pageParam, signal }) => dataService.getBrainGraph({ ...params, cursor: pageParam }, signal),
    {
      ...freshness,
      enabled: enabled && !!user?.id,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    },
  );
}

export function useBrainNodeQuery(id: string | null, generationId?: string) {
  const { data: user } = useGetUserQuery();
  return useQuery(
    [QueryKeys.brain, user?.id, 'node', id, ...(generationId ? [generationId] : [])],
    ({ signal }) => dataService.getBrainNode(id!, signal, generationId),
    { ...freshness, enabled: !!user?.id && !!id },
  );
}

export function useBrainRecallsQuery(conversationId?: string) {
  const { data: user } = useGetUserQuery();
  return useQuery(
    [QueryKeys.brain, user?.id, 'recalls', conversationId],
    ({ signal }) => dataService.getBrainRecalls(conversationId!, signal),
    {
      ...freshness,
      enabled: !!user?.id && !!conversationId && conversationId !== 'new',
      refetchInterval: 20_000,
    },
  );
}

export function useBrainMutations() {
  const queryClient = useQueryClient();
  const { data: user } = useGetUserQuery();
  const refresh = () => queryClient.invalidateQueries([QueryKeys.brain, user?.id]);
  const create = useMutation(
    [MutationKeys.createBrainNode],
    (data: BrainNodeInput) => dataService.createBrainNode(data),
    {
      onSuccess: refresh,
    },
  );
  const update = useMutation(
    [MutationKeys.updateBrainNode],
    ({ id, data }: { id: string; data: BrainNodeUpdate }) => dataService.updateBrainNode(id, data),
    { onSuccess: refresh },
  );
  const forget = useMutation(
    [MutationKeys.forgetBrainNode],
    (id: string) => dataService.deleteBrainNode(id),
    {
      onSuccess: async (_result, id) => {
        queryClient.removeQueries([QueryKeys.brain, user?.id, 'node', id]);
        await refresh();
      },
    },
  );
  const download = useMutation([MutationKeys.exportBrain], () => dataService.exportBrain());
  return { create, update, forget, download };
}
