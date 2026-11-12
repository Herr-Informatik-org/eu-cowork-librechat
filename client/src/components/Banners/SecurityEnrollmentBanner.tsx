import { useRecoilCallback, useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import { useActiveJobs, useGetStartupConfig } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import store from '~/store';

export function SecurityCenterButton() {
  const localize = useLocalize();
  const submitting = useRecoilValue(store.anySubmittingSelector);
  const readSubmitting = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.anySubmittingSelector).valueOrThrow(),
    [],
  );
  const { data, refetch, isFetching } = useActiveJobs(true);
  const busy = submitting || isFetching || (data?.activeJobIds?.length ?? 0) > 0;
  const open = async () => {
    if (readSubmitting()) return;
    const latest = await refetch();
    if (latest.isError || readSubmitting() || (latest.data?.activeJobIds?.length ?? 0) > 0) return;
    window.location.assign('/api/auth/security/page?manage=1');
  };
  return (
    <Button
      disabled={busy}
      onClick={open}
      title={busy ? localize('com_auth_security_wait') : undefined}
    >
      {localize('com_auth_security_center')}
    </Button>
  );
}

export default function SecurityEnrollmentBanner() {
  const { user } = useAuthContext();
  const { data: config } = useGetStartupConfig();
  const localize = useLocalize();
  if (!config?.securityRequired || !user || user.twoFactorEnabled || user.securityEnrolled)
    return null;
  return (
    <aside
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border-medium bg-surface-secondary p-3 text-sm"
    >
      <p>{localize('com_auth_security_setup_hint')}</p>
      <SecurityCenterButton />
    </aside>
  );
}
