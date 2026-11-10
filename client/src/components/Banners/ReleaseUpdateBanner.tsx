import { useEffect, useState } from 'react';
import { useRecoilCallback, useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import { useActiveJobs } from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

const VERSION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export default function ReleaseUpdateBanner() {
  const localize = useLocalize();
  const [available, setAvailable] = useState(false);
  const isSubmitting = useRecoilValue(store.anySubmittingSelector);
  const readSubmitting = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.anySubmittingSelector).valueOrThrow(),
    [],
  );
  const { data: activeJobs, refetch, isFetching } = useActiveJobs(available);
  const working = isSubmitting || (activeJobs?.activeJobIds?.length ?? 0) > 0;

  useEffect(() => {
    const current = document.querySelector<HTMLMetaElement>('meta[name="kisuno-release"]')?.content;
    if (!current || !VERSION_PATTERN.test(current)) return;
    const endpoint = new URL('api/kisuno-release-version', document.baseURI);
    if (endpoint.origin !== window.location.origin) return;

    let pending: AbortController | undefined;
    async function poll() {
      if (pending || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(endpoint, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
          return;
        }
        const { version } = (await response.json()) as { version?: unknown };
        if (
          !controller.signal.aborted &&
          typeof version === 'string' &&
          VERSION_PATTERN.test(version)
        ) {
          setAvailable(version !== current);
        }
      } catch {
        // A temporarily unavailable version check must not interrupt chat work.
      } finally {
        window.clearTimeout(timeout);
        pending = undefined;
      }
    }

    void poll();
    const interval = window.setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', poll);
      pending?.abort();
    };
  }, []);

  if (!available) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary">
      <p role="status">
        {localize(working ? 'com_ui_release_wait_for_jobs' : 'com_ui_release_available')}
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={working || isFetching}
        onClick={async () => {
          const result = await refetch();
          if (result.isSuccess && result.data.activeJobIds.length === 0 && !readSubmitting()) {
            window.location.reload();
          }
        }}
      >
        {localize('com_sources_reload_page')}
      </Button>
    </div>
  );
}
