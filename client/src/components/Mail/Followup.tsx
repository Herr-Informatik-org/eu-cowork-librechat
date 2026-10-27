import { useEffect, useRef, useState } from 'react';
import { ClipboardList, Loader2 } from 'lucide-react';
import type { MailWorkspaceResult, MailFollowupProfile } from 'librechat-data-provider';
import {
  useMailFollowupSettings,
  useMailFollowupProjects,
  useMailFollowupActions,
} from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';

export function mailActionError(error: unknown, fallback: string): string {
  const response = error as { response?: { data?: { error?: unknown } } } | null | undefined;
  const message = response?.response?.data?.error;
  return typeof message === 'string' && message ? message : fallback;
}

export function safeOdooTaskUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.origin === 'https://erp.rzcloud.ch' &&
      !url.username &&
      !url.password &&
      (url.pathname === '/web' || url.pathname.startsWith('/odoo/'))
    )
      return url.href;
  } catch {
    return;
  }
}

export function MailFollowupSettings() {
  const t = useLocalize();
  const [open, setOpen] = useState(false);
  const query = useMailFollowupSettings(open);
  const actions = useMailFollowupActions();
  const [profile, setProfile] = useState<MailFollowupProfile>();
  const [mode, setMode] = useState<'project' | 'todo'>('project');
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [project, setProject] = useState<number>();
  const initialized = useRef(false);
  const projects = useMailFollowupProjects(mode === 'project' ? profile : undefined, submitted);
  const settings = query.data?.settings;
  const selectedProfile = profile || settings?.profile;
  const savedProject =
    selectedProfile === settings?.profile && settings?.mode === 'project'
      ? settings.projectId
      : undefined;
  const busy = actions.settings.isLoading;
  useEffect(() => {
    if (!query.data || initialized.current) return;
    initialized.current = true;
    if (!query.data.settings) return;
    setProfile(query.data.settings.profile);
    setMode(query.data.settings.mode);
    setProject(query.data.settings.projectId);
  }, [query.data]);
  return (
    <details
      className="mail-followup-settings"
      data-mail-shortcuts="off"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t('com_ui_mail_followup_settings')}</summary>
      <p className="mail-muted">{t('com_ui_mail_followup_scope')}</p>
      {settings && (
        <p>
          {t('com_ui_mail_followup_saved_target')}:{' '}
          {settings.mode === 'todo' ? t('com_ui_mail_followup_todo') : settings.projectName}
          {' · '}
          {settings.userName}
        </p>
      )}
      {query.isLoading && open && <p role="status">{t('com_ui_loading')}</p>}
      {query.isError && (
        <p role="alert" className="mail-error">
          {mailActionError(query.error, t('com_ui_mail_followup_error'))}
        </p>
      )}
      {query.data?.profiles.length === 0 && <p>{t('com_ui_mail_followup_no_profile')}</p>}
      {!!query.data?.profiles.length && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedProfile || (mode === 'project' && !project)) return;
            actions.settings.mutate({
              profile: selectedProfile,
              mode,
              ...(mode === 'project' ? { projectId: project } : {}),
            });
          }}
        >
          <label>
            {t('com_ui_mail_followup_profile')}
            <select
              value={selectedProfile || ''}
              disabled={busy}
              onChange={(event) => {
                setProfile(event.target.value as MailFollowupProfile);
                setProject(undefined);
                setSubmitted('');
                actions.settings.reset();
              }}
            >
              <option value="" disabled>
                {t('com_ui_mail_followup_choose_profile')}
              </option>
              {query.data.profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('com_ui_mail_followup_destination')}
            <select
              value={mode}
              disabled={busy}
              onChange={(event) => {
                setMode(event.target.value as 'project' | 'todo');
                actions.settings.reset();
              }}
            >
              <option value="project">{t('com_ui_mail_followup_project')}</option>
              <option value="todo">{t('com_ui_mail_followup_todo')}</option>
            </select>
          </label>
          {mode === 'todo' && <p className="mail-muted">{t('com_ui_mail_followup_todo_scope')}</p>}
          {mode === 'project' && (
            <>
              <label>
                {t('com_ui_mail_followup_project_search')}
                <input
                  value={search}
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="mail-button"
                disabled={!selectedProfile || search.trim().length < 2 || busy}
                onClick={() => {
                  setProfile(selectedProfile);
                  setSubmitted(search.trim());
                  setProject(undefined);
                }}
              >
                {t('com_ui_search')}
              </button>
              {projects.isFetching && <p role="status">{t('com_ui_loading')}</p>}
              {projects.isError && (
                <p role="alert" className="mail-error">
                  {mailActionError(projects.error, t('com_ui_mail_followup_error'))}
                </p>
              )}
              {(projects.data || savedProject) && (
                <label>
                  {t('com_ui_mail_followup_project')}
                  <select
                    value={project || ''}
                    disabled={busy}
                    onChange={(event) => setProject(Number(event.target.value))}
                  >
                    <option value="" disabled>
                      {t('com_ui_mail_followup_choose_project')}
                    </option>
                    {savedProject &&
                      !projects.data?.projects.some((item) => item.id === savedProject) && (
                        <option value={savedProject}>{settings?.projectName}</option>
                      )}
                    {projects.data?.projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {projects.data?.projects.length === 0 && (
                    <span>{t('com_ui_mail_followup_no_project')}</span>
                  )}
                </label>
              )}
            </>
          )}
          <button
            type="submit"
            className="mail-button primary"
            disabled={busy || !selectedProfile || (mode === 'project' && !project)}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t('com_ui_mail_followup_save')}
          </button>
          {actions.settings.isSuccess && <p role="status">{t('com_ui_mail_followup_saved')}</p>}
          {actions.settings.isError && (
            <p role="alert" className="mail-error">
              {mailActionError(actions.settings.error, t('com_ui_mail_followup_error'))}
            </p>
          )}
        </form>
      )}
    </details>
  );
}

export function MailFollowupAction({ result }: { result: MailWorkspaceResult }) {
  return <FollowupAction key={`${result.id}:${result.revision}`} result={result} />;
}

function FollowupAction({ result }: { result: MailWorkspaceResult }) {
  const t = useLocalize();
  const actions = useMailFollowupActions();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<number>();
  const preview = actions.prepare.data;
  const outcome = actions.commit.data || preview?.existing;
  const taskUrl = safeOdooTaskUrl(outcome?.taskUrl);
  const pending = actions.prepare.isLoading || actions.commit.isLoading;
  return (
    <div className="mail-followup-action" data-mail-shortcuts="off">
      <button
        className="mail-button"
        disabled={pending || result.moveStatus === 'uncertain'}
        onClick={() => {
          setOpen(true);
          actions.commit.reset();
          actions.prepare.mutate(
            { id: result.id, revision: result.revision },
            {
              onSuccess: (value) =>
                setTaskId('suggestedTaskId' in value ? value.suggestedTaskId : undefined),
            },
          );
        }}
      >
        {pending ? <Loader2 size={14} className="animate-spin" /> : <ClipboardList size={14} />}
        {t('com_ui_mail_followup_start')}
      </button>
      {open && (
        <section
          className="mail-card mail-followup-review"
          aria-label={t('com_ui_mail_followup_review')}
        >
          <div className="mail-settings-heading">
            <h3>{t('com_ui_mail_followup_review')}</h3>
            <button className="mail-button" onClick={() => setOpen(false)}>
              {t('com_ui_mail_close')}
            </button>
          </div>
          {pending && (
            <p role="status">
              {t(
                actions.commit.isLoading
                  ? 'com_ui_mail_followup_saving'
                  : 'com_ui_mail_followup_searching',
              )}
            </p>
          )}
          {(actions.prepare.isError || actions.commit.isError) && (
            <p role="alert" className="mail-error">
              {mailActionError(
                actions.prepare.error || actions.commit.error,
                t('com_ui_mail_followup_error'),
              )}
            </p>
          )}
          {outcome ? (
            <div role="status">
              <p>
                {t(
                  outcome.status === 'completed'
                    ? 'com_ui_mail_followup_completed'
                    : 'com_ui_mail_followup_uncertain',
                )}
              </p>
              {taskUrl && (
                <a className="mail-button" href={taskUrl} target="_blank" rel="noopener noreferrer">
                  {t('com_ui_mail_followup_open')}
                </a>
              )}
            </div>
          ) : (
            preview &&
            'token' in preview && (
              <>
                <p>
                  <strong>{preview.targetLabel}</strong>
                </p>
                <p className="mail-muted">{t('com_ui_mail_followup_preview_scope')}</p>
                {preview.writeAvailable !== true && (
                  <p className="mail-notice" role="status">
                    {t('com_ui_mail_followup_write_unavailable')}{' '}
                    {preview.writeReason || t('com_ui_mail_followup_write_safety')}
                  </p>
                )}
                <fieldset disabled={pending}>
                  <legend>{t('com_ui_mail_followup_matching')}</legend>
                  {preview.candidates.map((candidate) => (
                    <label className="mail-check" key={candidate.id}>
                      <input
                        type="radio"
                        name={`task-${result.id}`}
                        checked={taskId === candidate.id}
                        onChange={() => setTaskId(candidate.id)}
                      />
                      <span>
                        {candidate.name}
                        {candidate.customer ? ` · ${candidate.customer}` : ''}
                      </span>
                    </label>
                  ))}
                  <label className="mail-check">
                    <input
                      type="radio"
                      name={`task-${result.id}`}
                      checked={taskId === undefined}
                      onChange={() => setTaskId(undefined)}
                    />
                    {t('com_ui_mail_followup_create')}: {preview.title}
                  </label>
                </fieldset>
                <details className="mail-followup-body">
                  <summary>{t('com_ui_mail_followup_note_preview')}</summary>
                  <pre>{preview.body}</pre>
                </details>
                <p className="mail-muted">{t('com_ui_mail_followup_shared_note')}</p>
                <button
                  className="mail-button primary"
                  disabled={pending || preview.writeAvailable !== true}
                  onClick={() => {
                    if (pending || preview.writeAvailable !== true) return;
                    actions.commit.mutate({
                      token: preview.token,
                      ...(taskId === undefined ? {} : { taskId }),
                    });
                  }}
                >
                  {t(
                    taskId === undefined
                      ? 'com_ui_mail_followup_create_confirm'
                      : 'com_ui_mail_followup_append_confirm',
                  )}
                </button>
              </>
            )
          )}
        </section>
      )}
    </div>
  );
}
