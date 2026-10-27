import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Check, FolderCheck, Loader2 } from 'lucide-react';
import type { MailWorkspaceMoveJob, MailWorkspaceMoveRequest } from 'librechat-data-provider';
import { useMailActions, useMailPendingActions } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';

export type MoveSelection = {
  request: MailWorkspaceMoveRequest;
  folderName: string;
  subjects: string[];
};
const jobLabels: Record<MailWorkspaceMoveJob['status'], TranslationKeys> = {
  queued: 'com_ui_mail_job_queued',
  running: 'com_ui_mail_job_running',
  completed: 'com_ui_mail_job_completed',
  partial: 'com_ui_mail_job_failed',
  failed: 'com_ui_mail_job_failed',
  cancelled: 'com_ui_mail_job_cancelled',
};
export const isMoveActive = (job: MailWorkspaceMoveJob) =>
  job.status === 'queued' || job.status === 'running';

function JobProgress({
  job,
  onStop,
  stopping,
}: {
  job: MailWorkspaceMoveJob;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const t = useLocalize();
  const active = isMoveActive(job);
  const errors = job.items.filter((item) =>
    ['failed', 'uncertain', 'cancelled'].includes(item.status),
  );
  const processed = job.items.filter(
    (item) => item.status !== 'queued' && item.status !== 'running',
  ).length;
  const heading = jobLabels[job.status];
  return (
    <article key={job.id} className="mail-job">
      <div className="mail-job-heading">
        <strong>
          {active ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t(heading)}
        </strong>
        <span className="mail-job-amount">
          {t('com_ui_mail_job_progress', { done: processed, total: job.total })}
        </span>
        {active && (
          <span className="mail-job-target" title={job.folderName}>
            {job.folderName || t('com_ui_mail_job_validate_folder')}
          </span>
        )}
        {active && onStop && (
          <button
            className="mail-button mail-job-stop"
            disabled={stopping}
            onClick={onStop}
            aria-label={t('com_ui_mail_stop_jobs')}
            title={t('com_ui_mail_stop_jobs')}
          >
            {t('com_ui_mail_stop_short')}
          </button>
        )}
      </div>
      {!active && (
        <progress aria-label={t('com_ui_mail_jobs')} max={job.total || 1} value={processed} />
      )}
      {!active && (
        <>
          <p>
            {job.folderName
              ? t('com_ui_mail_job_folder', { folder: job.folderName })
              : t('com_ui_mail_job_validate_folder')}
          </p>
          <p>{t('com_ui_mail_job_counts', { succeeded: job.completed, failed: errors.length })}</p>
        </>
      )}
      {errors.length > 0 && (
        <details>
          <summary>{t('com_ui_mail_job_errors', { count: errors.length })}</summary>
          <ul className="mail-job-errors">
            {errors.map((item) => (
              <li key={item.id}>
                <strong>{item.subject || t('com_ui_mail_no_subject')}</strong>:{' '}
                {item.error || t('com_ui_mail_job_item_error')}
                {item.status === 'uncertain' && <p>{t('com_ui_mail_job_uncertain')}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
export function MoveProgress({
  jobs,
  running,
  details,
  odooAvailable = false,
}: {
  jobs: MailWorkspaceMoveJob[];
  running: boolean;
  details: ReactNode;
  odooAvailable?: boolean;
}) {
  const t = useLocalize();
  const actions = useMailActions();
  const pending = useMailPendingActions();
  const active = jobs.filter(isMoveActive);
  const history = jobs.filter((job) => !isMoveActive(job)).slice(0, 5);
  const hints = jobs.reduce(
    (count, job) =>
      count +
      job.items.filter((item) => ['failed', 'uncertain', 'cancelled'].includes(item.status)).length,
    0,
  );
  return (
    <section className="mail-activity" aria-label={t('com_ui_mail_activity')}>
      <div className="mail-activity-row">
        {active.map((job) => {
          const processed = job.items.filter(
            (item) => item.status !== 'queued' && item.status !== 'running',
          ).length;
          return (
            <div
              key={job.id}
              className="mail-activity-move"
              role="status"
              aria-label={t('com_ui_mail_jobs')}
            >
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              <span>{t(jobLabels[job.status])}</span>
              <strong>
                {processed}/{job.total}
              </strong>
              <progress aria-label={t('com_ui_mail_jobs')} max={job.total || 1} value={processed} />
              <span className="mail-job-target" title={job.folderName}>
                {job.folderName || t('com_ui_mail_job_validate_folder')}
              </span>
              <button
                className="mail-button mail-job-stop"
                disabled={actions.pause.isLoading}
                onClick={() => actions.pause.mutate()}
                aria-label={t('com_ui_mail_stop_jobs')}
                title={t('com_ui_mail_stop_jobs')}
              >
                {t('com_ui_mail_stop_short')}
              </button>
            </div>
          );
        })}
        {!active.length && history.length > 0 && (
          <span className="mail-activity-completed" role="status">
            <Check size={13} aria-hidden="true" />
            {t('com_ui_mail_activity_moved', { count: history[0].completed })}
          </span>
        )}
        <span
          className="mail-activity-analysis"
          role="status"
          title={running ? t('com_ui_mail_running') : undefined}
        >
          <span className={`mail-status-dot ${running ? 'running' : ''}`} />
          {running ? t('com_ui_mail_running_short') : t('com_ui_mail_ready')}
          {running && <progress aria-label={t('com_ui_mail_analysis_progress')} />}
        </span>
        {(pending.chat > 0 || pending.draft > 0 || (odooAvailable && pending.followup > 0)) && (
          <span className="mail-activity-pending" role="status">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {[
              pending.chat > 0 ? t('com_ui_mail_chat_inline_thinking') : '',
              pending.draft > 0 ? t('com_ui_mail_draft_running_short') : '',
              odooAvailable && pending.followup > 0 ? t('com_ui_mail_followup_pending') : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <details className="mail-activity-details">
          <summary className={hints ? 'mail-activity-warning' : ''}>
            {hints
              ? t('com_ui_mail_activity_hints', { count: hints })
              : t('com_ui_mail_activity_details')}
          </summary>
          <div className="mail-activity-popover">
            <div className="mail-activity-stats">{details}</div>
            {active.map((job) => (
              <JobProgress key={job.id} job={job} />
            ))}
            {history.length > 0 && (
              <section aria-label={t('com_ui_mail_job_history')}>
                <h3>{t('com_ui_mail_job_history')}</h3>
                {history.map((job) => (
                  <JobProgress key={job.id} job={job} />
                ))}
              </section>
            )}
          </div>
        </details>
      </div>
      {actions.pause.isError && (
        <p className="mail-error" role="alert">
          {t('com_ui_mail_stop_error')}
        </p>
      )}
    </section>
  );
}

export function MoveDialog({
  selection,
  onClose,
  onAccepted,
}: {
  selection: MoveSelection;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const t = useLocalize();
  const actions = useMailActions();
  const cancel = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const workspace = container.current?.closest<HTMLElement>('.mail-workspace');
    cancel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else if (workspace?.isConnected) workspace.focus();
    };
  }, []);
  return (
    <div className="mail-move-overlay">
      <div
        className="mail-move-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mail-move-title"
        ref={container}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !actions.enqueueMove.isLoading) onClose();
          if (event.key !== 'Tab') return;
          const buttons = Array.from(
            container.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
          );
          const first = buttons.at(0);
          const last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id="mail-move-title">
          {t('com_ui_mail_bulk_title', { count: selection.request.items.length })}
        </h2>
        <p>
          {t('com_ui_mail_bulk_confirm', {
            count: selection.request.items.length,
            folder: selection.folderName,
          })}
        </p>
        <ul className="mail-move-items">
          {selection.subjects.map((subject, i) => (
            <li key={selection.request.items[i].id}>{subject || t('com_ui_mail_no_subject')}</li>
          ))}
        </ul>
        <p className="mail-muted">{t('com_ui_mail_bulk_hint')}</p>
        {actions.enqueueMove.isError && (
          <p className="mail-error" role="alert">
            {t('com_ui_mail_job_submit_error')}
          </p>
        )}
        <div className="mail-detail-tools">
          <button
            className="mail-button primary"
            disabled={actions.enqueueMove.isLoading}
            onClick={() => actions.enqueueMove.mutate(selection.request, { onSuccess: onAccepted })}
          >
            <FolderCheck size={16} />
            {actions.enqueueMove.isLoading
              ? t('com_ui_mail_job_submitting')
              : t('com_ui_mail_move_now')}
          </button>
          <button
            ref={cancel}
            className="mail-button"
            disabled={actions.enqueueMove.isLoading}
            onClick={onClose}
          >
            {t('com_ui_mail_cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
