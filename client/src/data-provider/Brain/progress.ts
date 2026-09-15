import { useBrainHistory } from './history';
import { useBrainRebuild } from './rebuild';

/** One history observer drives progress; rebuild polling is only needed while it is not running. */
export function useBrainProgress(enabled: boolean) {
  const history = useBrainHistory(enabled);
  const status = history.history.data?.status;
  const rebuild = useBrainRebuild(
    enabled,
    status !== 'running' && status !== 'paused' && status !== 'failed',
  );
  return { history, rebuild };
}
