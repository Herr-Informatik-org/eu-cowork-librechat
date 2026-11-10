import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { OpsAuthorization, OpsPersonalScope } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';

export function useOpsPersonal(authorization: OpsAuthorization | null) {
  const { user, isAuthenticated } = useAuthContext();
  const client = useQueryClient();
  const key = [QueryKeys.opsPersonal, user?.id];
  const consent = useQuery(
    [...key, 'consent', authorization],
    ({ signal }) => dataService.getOpsPersonalConsent(authorization!, signal),
    { enabled: isAuthenticated && !!authorization, retry: false, cacheTime: 0 },
  );
  const grants = useQuery(
    [...key, 'grants'],
    ({ signal }) => dataService.getOpsPersonalGrants(signal),
    { enabled: isAuthenticated, retry: false, cacheTime: 0 },
  );
  const approve = useMutation([MutationKeys.opsPersonalConsent], (scopes: OpsPersonalScope[]) =>
    dataService.approveOpsPersonal(authorization!, scopes),
  );
  const revoke = useMutation([MutationKeys.opsPersonalRevoke], dataService.revokeOpsPersonalGrant, {
    onSuccess: () => client.invalidateQueries(key),
  });
  return { consent, grants, approve, revoke };
}
