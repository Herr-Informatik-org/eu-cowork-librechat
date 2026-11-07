import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { MailResearchRunRequest, MailResearchSkillInput } from 'librechat-data-provider';
import store from '~/store';

const options = { staleTime: 0, cacheTime: 0, retry: false, refetchOnWindowFocus: false };
export function useMailResearchSettings(enabled = true) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'research-settings'],
    ({ signal }) => dataService.getMailResearchSettings(signal),
    { ...options, enabled: enabled && !!user?.id },
  );
}
export function useMailResearchCustomers(profileId: string, search: string, enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'research-customers', profileId, search],
    ({ signal }) => dataService.getMailResearchCustomers(profileId, search, signal),
    { ...options, enabled: enabled && !!user?.id && !!profileId && search.trim().length >= 2 },
  );
}
export function useMailResearchJobs(enabled: boolean) {
  const user = useRecoilValue(store.user);
  return useQuery(
    [QueryKeys.mailWorkspace, user?.id, 'research-jobs'],
    ({ signal }) => dataService.getMailResearchJobs(signal),
    {
      ...options,
      enabled: enabled && !!user?.id,
      refetchOnWindowFocus: true,
      refetchInterval: (data) =>
        data?.some((job) => job.status === 'queued' || job.status === 'running') ? 2500 : false,
    },
  );
}
export function useMailResearchActions() {
  const user = useRecoilValue(store.user);
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries([QueryKeys.mailWorkspace, user?.id]);
  const mutationOptions = { retry: false, networkMode: 'always' as const, onSuccess: refresh };
  const save = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'research-save'],
    ({ id, input }: { id: string; input: MailResearchSkillInput }) =>
      dataService.saveMailResearchSkill(id, input),
    mutationOptions,
  );
  const run = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'research-run'],
    ({ id, input }: { id: string; input: MailResearchRunRequest }) =>
      dataService.runMailResearch(id, input),
    mutationOptions,
  );
  const cancel = useMutation(
    [MutationKeys.mailWorkspace, user?.id, 'research-cancel'],
    (id: string) => dataService.cancelMailResearchJob(id),
    mutationOptions,
  );
  return { save, run, cancel };
}
