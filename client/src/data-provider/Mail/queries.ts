import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type {
  MailWorkspaceParams,
  MailWorkspacePriority,
  MailWorkspaceSettings,
  MailWorkspaceMoveRequest,
  MailWorkspaceMoveJob,
  MailWorkspaceRule,
} from 'librechat-data-provider';
import { useRecoilValue } from 'recoil';
import store from '~/store';

const freshness = { staleTime: 10_000, refetchOnWindowFocus: false, retry: false, cacheTime: 0 };
export function useMailAvailability() {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'availability'],
    ({ signal }) => dataService.getMailWorkspaceAvailability(signal),
    { ...freshness, staleTime: 300_000, enabled: !!user?.id },
  );
}
export function useMailStatus(enabled = true) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'status'],
    ({ signal }) => dataService.getMailWorkspaceStatus(signal),
    { ...freshness, enabled: enabled && !!user?.id, refetchInterval: 10_000 },
  );
}
export function useMailResults(params: MailWorkspaceParams, enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useInfiniteQuery(
    [QueryKeys.mailWorkspace, user?.id, 'results', params],
    ({ pageParam, signal }) =>
      dataService.getMailWorkspaceResults({ ...params, cursor: pageParam }, signal),
    {
      ...freshness,
      enabled: enabled && !!user?.id,
      getNextPageParam: (page) => page.nextCursor || undefined,
    },
  );
}
export function useMailContent(id: string | null, revision?: string) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'content', id, revision],
    ({ signal }) => dataService.getMailWorkspaceContent(id!, signal),
    { ...freshness, enabled: !!user?.id && !!id },
  );
}
export function useMailFolders(enabled: boolean, parentId?: string) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'folders', parentId],
    ({ signal }) => dataService.getMailWorkspaceFolders(parentId, signal),
    { ...freshness, enabled: enabled && !!user?.id },
  );
}
export function useMailMoveJobs(enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'move-jobs'],
    ({ signal }) => dataService.getMailWorkspaceMoveJobs(signal),
    {
      ...freshness,
      enabled: enabled && !!user?.id,
      refetchOnWindowFocus: true,
      refetchInterval: (data) =>
        data?.jobs.some((job) => job.status === 'queued' || job.status === 'running')
          ? 2000
          : false,
    },
  );
}
export function useMailActions() {
  const user = useRecoilValue(store.user);
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries([QueryKeys.mailWorkspace, user?.id]);
  const options = { onSuccess: refresh };
  const connect = useMutation(
    [MutationKeys.mailWorkspace, 'connect'],
    dataService.connectMailWorkspace,
  );
  const settings = useMutation(
    [MutationKeys.mailWorkspace, 'settings'],
    (input: MailWorkspaceSettings) => dataService.saveMailWorkspaceSettings(input),
    options,
  );
  const run = useMutation(
    [MutationKeys.mailWorkspace, 'run'],
    dataService.runMailWorkspace,
    options,
  );
  const pause = useMutation(
    [MutationKeys.mailWorkspace, 'pause'],
    dataService.pauseMailWorkspace,
    options,
  );
  const disconnect = useMutation(
    [MutationKeys.mailWorkspace, 'disconnect'],
    dataService.disconnectMailWorkspace,
    {
      onSuccess: async () => {
        client.removeQueries([QueryKeys.mailWorkspace, user?.id]);
        await refresh();
      },
    },
  );
  const priority = useMutation(
    [MutationKeys.mailWorkspace, 'priority'],
    ({ id, priority }: { id: string; priority: MailWorkspacePriority }) =>
      dataService.prioritizeMailWorkspaceResult(id, priority),
    options,
  );
  const move = useMutation(
    [MutationKeys.mailWorkspace, 'move'],
    ({ id, folderId, revision }: { id: string; folderId: string; revision: string }) =>
      dataService.moveMailWorkspaceResult(id, folderId, revision),
    options,
  );
  const enqueueMove = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'enqueue-move'],
    (input: MailWorkspaceMoveRequest) => dataService.enqueueMailWorkspaceMove(input),
    {
      onSuccess: ({ job }) => {
        client.setQueryData<{ jobs: MailWorkspaceMoveJob[] }>(
          [QueryKeys.mailWorkspace, user?.id, 'move-jobs'],
          (previous) => ({
            jobs: [job, ...(previous?.jobs || []).filter((old) => old.id !== job.id)],
          }),
        );
      },
      onSettled: () => {
        void client.invalidateQueries([QueryKeys.mailWorkspace, user?.id, 'move-jobs']);
      },
    },
  );
  const draft = useMutation(
    [MutationKeys.mailWorkspace, 'draft'],
    ({ id, body, revision }: { id: string; body: string; revision: string }) =>
      dataService.saveMailWorkspaceDraft(id, body, revision),
    options,
  );
  const rule = useMutation(
    [MutationKeys.mailWorkspace, 'rule'],
    ({ id, ...input }: MailWorkspaceRule & { id: string }) =>
      dataService.rememberMailWorkspaceRule(id, input),
    options,
  );
  return {
    connect,
    settings,
    run,
    pause,
    disconnect,
    priority,
    move,
    enqueueMove,
    draft,
    rule,
    refresh,
  };
}
