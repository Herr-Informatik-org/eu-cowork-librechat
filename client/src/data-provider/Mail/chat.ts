import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type { MailWorkspaceChatRequest } from 'librechat-data-provider';
import store from '~/store';

export function useMailInbox(enabled: boolean) {
  const user = useRecoilValue(store.user);
  const client = useQueryClient();
  const key = [QueryKeys.mailWorkspace, user?.id, 'inbox'];
  const query = useInfiniteQuery(
    key,
    ({ pageParam, signal }) => dataService.getMailWorkspaceInbox({ cursor: pageParam }, signal),
    {
      enabled: enabled && !!user?.id,
      getNextPageParam: (page) => page.nextCursor || undefined,
      cacheTime: 0,
      staleTime: 10_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  return { ...query, refresh: () => client.resetQueries(key, { exact: true }) };
}

export function useMailChat(id: string) {
  const user = useRecoilValue(store.user);
  return useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'chat', id],
    (input: MailWorkspaceChatRequest) => dataService.chatMailWorkspace(id, input),
    { retry: false },
  );
}

export function useMailCorrespondence(id: string, search: string, enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useInfiniteQuery(
    [QueryKeys.mailWorkspace, user?.id, 'correspondence', id, search],
    ({ pageParam, signal }) =>
      dataService.getMailWorkspaceCorrespondence(id, { search, cursor: pageParam }, signal),
    {
      enabled: enabled && !!user?.id,
      getNextPageParam: (page) => page.nextCursor || undefined,
      cacheTime: 0,
      staleTime: 10_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
}
