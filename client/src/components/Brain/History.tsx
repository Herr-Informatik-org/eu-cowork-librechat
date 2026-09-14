import React, { useEffect, useId, useState } from 'react';
import { Button } from '@librechat/client';
import { Check, ChevronDown, History as HistoryIcon, Pause, Play } from 'lucide-react';
import useLocalize from '~/hooks/useLocalize';
import { useBrainHistory } from '~/data-provider/Brain';

const stateKeys = {
  idle: 'com_ui_brain_history_ready',
  running: 'com_ui_brain_history_running',
  paused: 'com_ui_brain_history_paused',
  completed: 'com_ui_brain_history_completed',
  failed: 'com_ui_brain_history_failed',
} as const;

export default function History({ enabled }: { enabled: boolean }) {
  const localize = useLocalize();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const { history, start, pause } = useBrainHistory(enabled);
  const data = history.data;
  const state = data?.status ?? 'idle';
  const active = state === 'running';
  useEffect(() => {
    if (state === 'running' || state === 'paused' || state === 'failed') setExpanded(true);
  }, [state]);
  const pending = start.isLoading || pause.isLoading;
  const processed = Math.max(0, data?.processed ?? 0);
  const total = Math.max(processed, data?.total ?? 0);
  if (!enabled) return null;

  const startLabel = () => {
    if (state === 'completed') return localize('com_ui_brain_history_check_new');
    if (state === 'paused' || state === 'failed') return localize('com_ui_brain_history_resume');
    return localize('com_ui_brain_history_start');
  };

  return (
    <section className="brain-history" aria-label={localize('com_ui_brain_history_title')}>
      <button
        type="button"
        className="brain-history-toggle"
        data-testid="brain-history-open"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        <HistoryIcon size={16} aria-hidden="true" />
        <span>{localize('com_ui_brain_history_title')}</span>
        {data && state !== 'idle' && (
          <span className="brain-history-status">{localize(stateKeys[state])}</span>
        )}
        <ChevronDown size={16} aria-hidden="true" className={expanded ? 'rotate-180' : ''} />
      </button>
      {expanded && (
        <div id={id} className="brain-history-content" data-testid="brain-history-panel">
          <div className="brain-history-explanation">
            <p>{localize('com_ui_brain_history_explanation')}</p>
            <p>
              {data?.modelLabel
                ? localize('com_ui_brain_history_model', { model: data.modelLabel })
                : localize('com_ui_brain_history_model_default')}
            </p>
          </div>
          {history.isLoading && !data && (
            <p role="status">{localize('com_ui_brain_history_loading')}</p>
          )}
          {history.isError && (
            <div className="brain-history-error" role="alert">
              <p>{localize('com_ui_brain_history_load_failed')}</p>
              <Button
                className="brain-button"
                variant="outline"
                size="sm"
                onClick={() => history.refetch()}
              >
                {localize('com_ui_brain_retry')}
              </Button>
            </div>
          )}
          {data && (
            <>
              {state !== 'idle' && (
                <div className="brain-history-progress">
                  <div className="brain-history-progress-heading" role="status">
                    {state === 'completed' && <Check size={16} aria-hidden="true" />}
                    <strong>{localize(stateKeys[state])}</strong>
                    <span>{localize('com_ui_brain_history_processed', { processed, total })}</span>
                  </div>
                  <progress
                    aria-label={localize('com_ui_brain_history_progress')}
                    max={Math.max(total, 1)}
                    value={active && total === 0 ? undefined : processed}
                  />
                  <p>
                    {localize('com_ui_brain_history_results', {
                      saved: data.saved,
                      skipped: data.skipped,
                    })}
                  </p>
                </div>
              )}
              {data.error && (
                <p className="brain-error" role="alert">
                  {data.error}
                </p>
              )}
              {!data.available && (
                <p className="brain-muted">
                  {data.reason || localize('com_ui_brain_history_unavailable')}
                </p>
              )}
              <div className="brain-history-actions">
                {active ? (
                  <Button
                    className="brain-button"
                    variant="outline"
                    size="sm"
                    data-testid="brain-history-pause"
                    disabled={pending}
                    onClick={() => {
                      start.reset();
                      pause.mutate();
                    }}
                  >
                    <Pause size={14} aria-hidden="true" />
                    {pause.isLoading
                      ? localize('com_ui_brain_history_pausing')
                      : localize('com_ui_brain_history_pause')}
                  </Button>
                ) : (
                  <Button
                    className="brain-button"
                    size="sm"
                    data-testid="brain-history-start"
                    disabled={pending || !data.available || history.isError}
                    onClick={() => {
                      pause.reset();
                      start.mutate();
                    }}
                  >
                    <Play size={14} aria-hidden="true" />
                    {start.isLoading ? localize('com_ui_brain_history_starting') : startLabel()}
                  </Button>
                )}
                {active && <p>{localize('com_ui_brain_history_background')}</p>}
                {state === 'completed' && <p>{localize('com_ui_brain_history_incremental')}</p>}
              </div>
            </>
          )}
          {(start.isError || pause.isError) && (
            <p className="brain-error" role="alert">
              {localize('com_ui_brain_history_action_failed')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
