import React, { useEffect, useId, useState } from 'react';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
} from '@librechat/client';
import { Check, ChevronDown, History as HistoryIcon, Pause, Play } from 'lucide-react';
import useLocalize from '~/hooks/useLocalize';
import { useBrainProgress } from '~/data-provider/Brain';
import Rebuild from './Rebuild';

const stateKeys = {
  idle: 'com_ui_brain_history_ready',
  running: 'com_ui_brain_history_running',
  paused: 'com_ui_brain_history_paused',
  completed: 'com_ui_brain_history_completed',
  failed: 'com_ui_brain_history_failed',
} as const;

type BrainProgress = ReturnType<typeof useBrainProgress>;

function ConnectedHistory({ enabled }: { enabled: boolean }) {
  const progress = useBrainProgress(enabled);
  return <HistoryContent enabled={enabled} progress={progress} />;
}

export default function History({
  enabled,
  progress,
}: {
  enabled: boolean;
  progress?: BrainProgress;
}) {
  return progress ? (
    <HistoryContent enabled={enabled} progress={progress} />
  ) : (
    <ConnectedHistory enabled={enabled} />
  );
}

function HistoryContent({ enabled, progress }: { enabled: boolean; progress: BrainProgress }) {
  const localize = useLocalize();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const { history, start, pause } = progress.history;
  const rebuildState = progress.rebuild;
  const draft = rebuildState.rebuild.data?.rebuild;
  const data = history.data;
  const state = data?.status ?? 'idle';
  const active = state === 'running';
  const hasDraft = !!draft;
  useEffect(() => {
    if (state === 'running' || state === 'paused' || state === 'failed' || hasDraft)
      setExpanded(true);
    if (hasDraft) setConfirmStart(false);
  }, [state, hasDraft]);
  const pending =
    start.isLoading ||
    pause.isLoading ||
    rebuildState.start.isLoading ||
    rebuildState.activate.isLoading ||
    rebuildState.discard.isLoading ||
    rebuildState.rollback.isLoading;
  const processed = Math.max(0, data?.processed ?? 0);
  const total = Math.max(processed, data?.total ?? 0);
  const contextual = data?.schemaVersion === 2 && data.unit === 'chats';
  const legacy = !!data && !contextual && state !== 'idle';
  const activatedRun =
    !draft &&
    data?.autoActivate === true &&
    rebuildState.rebuild.data?.activeGenerationId === data.rebuildId;
  const resumable =
    contextual &&
    (activatedRun ||
      ((draft?.status === 'building' || (draft?.status === 'ready' && draft.autoActivate)) &&
        draft.id === data?.rebuildId)) &&
    (state === 'paused' || state === 'failed');
  const orphaned =
    draft?.status === 'building' &&
    (draft.id !== data?.rebuildId || state === 'idle' || state === 'completed');
  const canPause =
    active && contextual && draft?.status === 'building' && draft.id === data?.rebuildId;
  const canStart = !canPause && (!draft || resumable || orphaned);
  const finalizing = active && data?.finalizing === true && draft?.id === data.rebuildId;
  const autoActivating =
    active && draft?.autoActivate === true && (draft.status === 'ready' || finalizing);
  const activeGenerationId = rebuildState.rebuild.data?.activeGenerationId;
  const autoCompleted =
    !draft &&
    data?.status === 'completed' &&
    data.autoActivate === true &&
    (!activeGenerationId || activeGenerationId === data.rebuildId);
  if (!enabled) return null;

  const startLabel = () => {
    if (resumable || orphaned) return localize('com_ui_brain_history_resume');
    if (state !== 'idle') return localize('com_ui_brain_rebuild_start');
    return localize('com_ui_brain_history_start');
  };
  const progressLabel = () => {
    if (autoCompleted) return localize('com_ui_brain_rebuild_activated');
    if (autoActivating) return localize('com_ui_brain_rebuild_auto_activating');
    if (draft?.status === 'ready' && !draft.autoActivate)
      return localize('com_ui_brain_rebuild_review');
    return localize(stateKeys[state]);
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
            <p>{localize('com_ui_brain_history_context_explanation')}</p>
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
              {legacy && (
                <p className="brain-rebuild-note">{localize('com_ui_brain_history_legacy')}</p>
              )}
              {state !== 'idle' && !legacy && (
                <div className="brain-history-progress">
                  <div className="brain-history-progress-heading" role="status">
                    {state === 'completed' && <Check size={16} aria-hidden="true" />}
                    <strong>{progressLabel()}</strong>
                    <span>
                      {localize('com_ui_brain_history_chats_processed', { processed, total })}
                    </span>
                  </div>
                  <progress
                    aria-label={localize('com_ui_brain_history_progress')}
                    max={Math.max(total, 1)}
                    value={active && total === 0 ? undefined : processed}
                  />
                  <p>
                    {localize('com_ui_brain_history_chat_results', {
                      saved: data.saved,
                      skipped: data.skipped,
                    })}
                  </p>
                  {data.processedSections != null && (
                    <p className="brain-muted">
                      {localize('com_ui_brain_history_sections', { count: data.processedSections })}
                    </p>
                  )}
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
                {canPause && (
                  <Button
                    className="brain-button"
                    variant="outline"
                    size="sm"
                    data-testid="brain-history-pause"
                    disabled={pending || finalizing}
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
                )}
                {canStart && (
                  <Button
                    className="brain-button"
                    size="sm"
                    data-testid="brain-history-start"
                    disabled={
                      pending ||
                      !data.available ||
                      history.isError ||
                      rebuildState.rebuild.isError ||
                      !rebuildState.rebuild.data ||
                      (active && contextual && !orphaned)
                    }
                    onClick={() => {
                      pause.reset();
                      if (resumable) start.mutate();
                      else if (orphaned) {
                        start.reset();
                        rebuildState.start.mutate();
                      } else setConfirmStart(true);
                    }}
                  >
                    <Play size={14} aria-hidden="true" />
                    {start.isLoading || rebuildState.start.isLoading
                      ? localize('com_ui_brain_history_starting')
                      : startLabel()}
                  </Button>
                )}
                {active && contextual && <p>{localize('com_ui_brain_history_background')}</p>}
              </div>
            </>
          )}
          <Rebuild
            state={rebuildState}
            disabled={pending || finalizing || !data?.available || history.isError}
            running={active}
          />
          {(start.isError || pause.isError) && (
            <p className="brain-error" role="alert">
              {localize('com_ui_brain_history_action_failed')}
            </p>
          )}
        </div>
      )}
      <OGDialog open={confirmStart && !draft} onOpenChange={setConfirmStart}>
        <OGDialogContent className="brain-start-dialog w-11/12 max-w-md" showCloseButton={false}>
          <OGDialogTitle>{localize('com_ui_brain_rebuild_confirm_title')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_ui_brain_rebuild_confirm_auto')}</OGDialogDescription>
          <div className="brain-start-explanation">
            <p>{localize('com_ui_brain_rebuild_confirm_current')}</p>
            <p>{localize('com_ui_brain_rebuild_confirm_protected')}</p>
            <p>
              {data?.modelLabel
                ? localize('com_ui_brain_rebuild_confirm_cost', { model: data.modelLabel })
                : localize('com_ui_brain_history_model_default')}
            </p>
          </div>
          <div className="brain-history-actions justify-end">
            <Button variant="outline" onClick={() => setConfirmStart(false)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              disabled={
                pending || !data?.available || history.isError || rebuildState.rebuild.isError
              }
              data-testid="brain-rebuild-confirm-start"
              onClick={() => {
                setConfirmStart(false);
                start.reset();
                pause.reset();
                rebuildState.start.mutate();
              }}
            >
              {localize('com_ui_brain_rebuild_confirm_start')}
            </Button>
          </div>
        </OGDialogContent>
      </OGDialog>
    </section>
  );
}
