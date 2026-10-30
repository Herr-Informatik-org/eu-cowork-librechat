import { useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import { Button } from '@librechat/client';
import type { BrainQuality } from 'librechat-data-provider';
import { useBrainQuality } from '~/data-provider/Brain/quality';
import useLocalize from '~/hooks/useLocalize';

const reasons = {
  null_interval: 'com_ui_brain_quality_interval',
  unbounded_expiry: 'com_ui_brain_quality_expiry',
  general_preference_scope: 'com_ui_brain_quality_scope',
  duplicate_candidate: 'com_ui_brain_quality_duplicate',
  overloaded_memory: 'com_ui_brain_quality_overloaded',
  unverified_completion: 'com_ui_brain_quality_completion',
} as const;

function Changes({ finding }: { finding: BrainQuality['findings'][number] }) {
  const t = useLocalize();
  const changes = finding.proposedChanges;
  if (!changes) return null;
  return (
    <dl className="brain-quality-changes">
      {Object.hasOwn(changes, 'scope') && (
        <div>
          <dt>{t('com_ui_brain_scope_label')}</dt>
          <dd>
            <del>{finding.before.scope || t('com_ui_brain_quality_general')}</del> →{' '}
            <strong>{changes.scope || t('com_ui_brain_quality_general')}</strong>
          </dd>
        </div>
      )}
      {Object.hasOwn(changes, 'validUntil') && (
        <div>
          <dt>{t('com_ui_brain_valid_until')}</dt>
          <dd>
            <del>
              {finding.before.validUntil
                ? new Date(finding.before.validUntil).toLocaleDateString()
                : t('com_ui_brain_quality_unbounded')}
            </del>{' '}
            → <strong>{t('com_ui_brain_quality_unbounded')}</strong>
          </dd>
        </div>
      )}
    </dl>
  );
}

export default function Quality({
  enabled,
  busy,
  onSelect,
}: {
  enabled: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useLocalize();
  const [requested, setRequested] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<{ revision: number; ids: string[] }>({
    revision: -1,
    ids: [],
  });
  const { preview, prepare } = useBrainQuality(enabled && requested);
  useEffect(() => {
    if (prepare.isSuccess) setExpanded(false);
  }, [prepare.isSuccess]);
  const data = preview.data;
  const selected = selection.revision === data?.revision ? selection.ids : [];
  const pending = busy || prepare.isLoading || preview.isFetching;
  if (!enabled) return null;
  return (
    <details
      className="brain-quality"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (event.currentTarget.open) setRequested(true);
      }}
    >
      <summary>{t('com_ui_brain_quality_title')}</summary>
      <p className="brain-muted">{t('com_ui_brain_quality_hint')}</p>
      {preview.isFetching && <p role="status">{t('com_ui_brain_loading')}</p>}
      {preview.isError && (
        <p role="alert" className="brain-error">
          {t('com_ui_brain_quality_load_failed')}
        </p>
      )}
      {data && (
        <>
          {!data.findings.length && <p>{t('com_ui_brain_quality_empty')}</p>}
          <ul className="brain-quality-findings">
            {data.findings.map((finding) => (
              <li key={finding.id}>
                {finding.reviewOnly || !finding.proposedChanges ? (
                  <strong>{finding.before.title}</strong>
                ) : (
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(finding.id)}
                      disabled={pending}
                      onChange={(event) =>
                        setSelection({
                          revision: data.revision,
                          ids: event.target.checked
                            ? [...selected, finding.id]
                            : selected.filter((id) => id !== finding.id),
                        })
                      }
                    />
                    <strong>{finding.before.title}</strong>
                  </label>
                )}
                <p>{t(reasons[finding.reason])}</p>
                <p className="brain-muted">{finding.explanation}</p>
                <Changes finding={finding} />
                {finding.reviewOnly && (
                  <p className="brain-muted">{t('com_ui_brain_quality_review_only')}</p>
                )}
                <details>
                  <summary>{t('com_ui_brain_content_label')}</summary>
                  <p className="brain-node-text">{finding.before.text}</p>
                </details>
                <button
                  type="button"
                  className="brain-text-button"
                  onClick={() => onSelect(finding.nodeId)}
                >
                  {t('com_ui_brain_usage_details')}
                </button>
              </li>
            ))}
          </ul>
          {data.truncated && <p className="brain-muted">{t('com_ui_brain_quality_limited')}</p>}
        </>
      )}
      <div className="brain-history-actions">
        <Button
          className="brain-button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            prepare.reset();
            void preview.refetch();
          }}
        >
          {t('com_ui_brain_quality_refresh')}
        </Button>
        <Button
          className="brain-button"
          size="sm"
          disabled={pending || !data || preview.isError || !selected.length}
          onClick={() => {
            if (data && selected.length)
              prepare.mutate({ revision: data.revision, findingIds: selected });
          }}
        >
          {t('com_ui_brain_quality_prepare', { count: selected.length })}
        </Button>
      </div>
      {prepare.isSuccess && <p role="status">{t('com_ui_brain_quality_prepared')}</p>}
      {prepare.isError && (
        <p role="alert" className="brain-error">
          {t(
            isAxiosError(prepare.error) && prepare.error.response?.status === 409
              ? 'com_ui_brain_quality_conflict'
              : 'com_ui_brain_quality_save_failed',
          )}
        </p>
      )}
    </details>
  );
}
