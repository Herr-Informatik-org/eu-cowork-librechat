import React, { useState } from 'react';
import { Button } from '@librechat/client';
import { RotateCcw } from 'lucide-react';
import type { BrainNode } from 'librechat-data-provider';
import type { useBrainRebuild } from '~/data-provider/Brain';
import useLocalize from '~/hooks/useLocalize';

const sourceRoleKeys = {
  user: 'com_ui_brain_source_user',
  assistant: 'com_ui_brain_source_assistant',
} as const;

function PreviewNodes({ nodes }: { nodes: BrainNode[] }) {
  const localize = useLocalize();
  return (
    <ul className="brain-rebuild-preview">
      {nodes.map((node) => (
        <li key={node.id}>
          <strong>{node.title}</strong>
          {node.scope && <span className="brain-muted">{node.scope}</span>}
          <p>{node.text}</p>
          {node.sources.some((source) => source.excerpt) && (
            <details>
              <summary>{localize('com_ui_brain_sources')}</summary>
              {node.sources
                .filter((source) => source.excerpt)
                .map((source) => (
                  <blockquote key={source.id}>
                    <span className="brain-muted">
                      {source.role ? localize(sourceRoleKeys[source.role]) : source.label}
                    </span>
                    <p>{source.excerpt}</p>
                  </blockquote>
                ))}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Rebuild({
  state,
  disabled,
}: {
  state: ReturnType<typeof useBrainRebuild>;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const [confirmRollback, setConfirmRollback] = useState(false);
  const { rebuild, activate, discard, rollback } = state;
  const data = rebuild.data;
  const draft = data?.rebuild;
  const pending =
    state.start.isLoading || activate.isLoading || discard.isLoading || rollback.isLoading;
  const reset = () => {
    state.start.reset();
    activate.reset();
    discard.reset();
    rollback.reset();
  };
  return (
    <>
      {!draft && activate.isSuccess && (
        <p role="status">{localize('com_ui_brain_rebuild_activated')}</p>
      )}
      {!draft && discard.isSuccess && (
        <p role="status">{localize('com_ui_brain_rebuild_discarded')}</p>
      )}
      {!draft && rollback.isSuccess && (
        <p role="status">{localize('com_ui_brain_rebuild_restored')}</p>
      )}
      {rebuild.isError && (
        <div className="brain-history-error" role="alert">
          <p>{localize('com_ui_brain_rebuild_load_failed')}</p>
          <Button
            className="brain-button"
            variant="outline"
            size="sm"
            onClick={() => rebuild.refetch()}
          >
            {localize('com_ui_brain_retry')}
          </Button>
        </div>
      )}
      {draft?.status === 'building' && (
        <div className="brain-rebuild-note">
          <p>{localize('com_ui_brain_rebuild_building')}</p>
          <Button
            className="brain-button"
            variant="outline"
            size="sm"
            disabled={pending || disabled || rebuild.isError}
            onClick={() => {
              reset();
              discard.mutate({ id: draft.id });
            }}
          >
            {localize('com_ui_brain_rebuild_discard')}
          </Button>
        </div>
      )}
      {draft?.status === 'ready' && (
        <section
          className="brain-rebuild-review"
          aria-label={localize('com_ui_brain_rebuild_review')}
        >
          <h3>{localize('com_ui_brain_rebuild_review')}</h3>
          <p>{localize('com_ui_brain_rebuild_ready')}</p>
          <dl className="brain-rebuild-counts">
            <div>
              <dt>{localize('com_ui_brain_rebuild_prepared')}</dt>
              <dd>{draft.counts.staged}</dd>
            </div>
            <div>
              <dt>{localize('com_ui_brain_rebuild_preserved')}</dt>
              <dd>{draft.counts.preserved}</dd>
            </div>
            <div>
              <dt>{localize('com_ui_brain_rebuild_retired')}</dt>
              <dd>{draft.counts.retired}</dd>
            </div>
          </dl>
          <details className="brain-rebuild-changes">
            <summary>{localize('com_ui_brain_rebuild_changes')}</summary>
            {draft.preview.added.length > 0 && (
              <>
                <h4>{localize('com_ui_brain_rebuild_prepared')}</h4>
                <PreviewNodes nodes={draft.preview.added} />
              </>
            )}
            {draft.preview.retired.length > 0 && (
              <>
                <h4>{localize('com_ui_brain_rebuild_retired')}</h4>
                <PreviewNodes nodes={draft.preview.retired} />
              </>
            )}
            {draft.previewTruncated && (
              <p className="brain-muted">{localize('com_ui_brain_rebuild_preview_limited')}</p>
            )}
            {draft.preview.added.length === 0 && draft.preview.retired.length === 0 && (
              <p>{localize('com_ui_brain_rebuild_no_changes')}</p>
            )}
          </details>
          <div className="brain-history-actions">
            <Button
              className="brain-button"
              size="sm"
              disabled={pending || disabled || rebuild.isError || rebuild.isFetching}
              data-testid="brain-rebuild-activate"
              onClick={() => {
                reset();
                activate.mutate({ id: draft.id, revision: draft.revision });
              }}
            >
              {localize('com_ui_brain_rebuild_activate')}
            </Button>
            <Button
              className="brain-button"
              variant="outline"
              size="sm"
              disabled={pending || disabled || rebuild.isError}
              onClick={() => {
                reset();
                discard.mutate({ id: draft.id });
              }}
            >
              {localize('com_ui_brain_rebuild_discard')}
            </Button>
          </div>
        </section>
      )}
      {!draft && data?.rollbackAvailable && (
        <div className="brain-rebuild-rollback">
          {confirmRollback ? (
            <>
              <p>{localize('com_ui_brain_rebuild_rollback_confirm')}</p>
              <div className="brain-history-actions">
                <Button
                  className="brain-button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmRollback(false)}
                >
                  {localize('com_ui_cancel')}
                </Button>
                <Button
                  className="brain-button"
                  size="sm"
                  disabled={pending || disabled || rebuild.isError}
                  onClick={() => {
                    reset();
                    rollback.mutate(undefined, { onSuccess: () => setConfirmRollback(false) });
                  }}
                >
                  {localize('com_ui_brain_rebuild_rollback')}
                </Button>
              </div>
            </>
          ) : (
            <button
              className="brain-text-button"
              disabled={pending || disabled || rebuild.isError}
              onClick={() => setConfirmRollback(true)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {localize('com_ui_brain_rebuild_rollback')}
            </button>
          )}
          {data.rollbackUntil && (
            <p className="brain-muted">
              {localize('com_ui_brain_rebuild_rollback_until', {
                date: new Date(data.rollbackUntil).toLocaleString(),
              })}
            </p>
          )}
        </div>
      )}
      {(state.start.isError || activate.isError || discard.isError || rollback.isError) && (
        <p className="brain-error" role="alert">
          {localize('com_ui_brain_rebuild_action_failed')}
        </p>
      )}
    </>
  );
}
