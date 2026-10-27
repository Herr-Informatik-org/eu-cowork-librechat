import { useQuery, useMutation, useQueryClient, useIsMutating } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import { useRecoilValue } from 'recoil';
import type {
  MailFollowupProfile,
  MailFollowupTarget,
  MailDraftRequest,
} from 'librechat-data-provider';
import store from '~/store';

const options = { staleTime: 0, cacheTime: 0, retry: false, refetchOnWindowFocus: false };

export function useMailPendingActions() {
  const user = useRecoilValue(store.user);
  const draft = useIsMutating([MutationKeys.mailWorkspace, user?.id, 'draft-request']);
  const prepare = useIsMutating([MutationKeys.mailWorkspace, user?.id, 'followup-prepare']);
  const commit = useIsMutating([MutationKeys.mailWorkspace, user?.id, 'followup-commit']);
  return { draft, followup: prepare + commit };
}

export function useMailFollowupSettings(enabled = true) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'followup-settings'],
    ({ signal }) => dataService.getMailFollowupSettings(signal),
    { ...options, enabled: enabled && !!user?.id },
  );
}

export function useMailFollowupProjects(profile?: MailFollowupProfile, search = '') {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'followup-projects', profile, search],
    ({ signal }) => dataService.getMailFollowupProjects(profile!, search, signal),
    { ...options, enabled: !!user?.id && !!profile && search.trim().length >= 2 },
  );
}

export function useMailFollowupActions() {
  const user = useRecoilValue(store.user);
  const client = useQueryClient();
  const settings = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'followup-settings'],
    (input: MailFollowupTarget) => dataService.saveMailFollowupSettings(input),
    {
      onSuccess: () =>
        client.invalidateQueries([QueryKeys.mailWorkspace, user?.id, 'followup-settings']),
    },
  );
  const prepare = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'followup-prepare'],
    ({ id, revision }: { id: string; revision: string }) =>
      dataService.prepareMailFollowup(id, revision),
    { retry: false },
  );
  const commit = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'followup-commit'],
    (input: { token: string; taskId?: number }) => dataService.commitMailFollowup(input),
    { retry: false },
  );
  return { settings, prepare, commit };
}

export function useMailDraftRequest() {
  const user = useRecoilValue(store.user);
  const client = useQueryClient();
  return useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'draft-request'],
    ({ id, ...input }: MailDraftRequest & { id: string }) =>
      dataService.requestMailWorkspaceDraft(id, input),
    {
      retry: false,
      onSettled: () => client.invalidateQueries([QueryKeys.mailWorkspace, user?.id]),
    },
  );
}

export function useMailAttachments(id: string, revision: string, enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'attachments', id, revision],
    ({ signal }) => dataService.getMailWorkspaceAttachments(id, signal),
    { ...options, enabled: enabled && !!user?.id },
  );
}
