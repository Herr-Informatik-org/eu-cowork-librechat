import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mail,
  Search,
  RefreshCw,
  Settings2,
  Play,
  Pause,
  Check,
  ArrowLeft,
  ChevronRight,
  MessageSquare,
  Copy,
  Save,
  FolderCheck,
  FileText,
  Loader2,
} from 'lucide-react';
import type {
  MailWorkspaceResult,
  MailWorkspacePriority,
  MailWorkspaceStatus,
  MailWorkspaceSettings,
  MailWorkspaceFolder,
} from 'librechat-data-provider';
import {
  useMailStatus,
  useMailResults,
  useMailContent,
  useMailFolders,
  useMailActions,
} from '~/data-provider/Mail';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useAuthContext, useLocalize, useNewConvo } from '~/hooks';
import { prepareMailChat } from './handoff';
import './workspace.css';

const consentVersion = '2026-10-27';
const priorities: Record<MailWorkspacePriority, TranslationKeys> = {
  important: 'com_ui_mail_important',
  normal: 'com_ui_mail_normal',
  low: 'com_ui_mail_low',
};
const draftStates: Record<MailWorkspaceResult['draftStatus'], TranslationKeys> = {
  none: 'com_ui_mail_no_draft',
  created: 'com_ui_mail_draft_ready',
  stale: 'com_ui_mail_draft_stale',
  uncertain: 'com_ui_mail_draft_uncertain',
  existing: 'com_ui_mail_draft_existing',
  error: 'com_ui_mail_draft_error',
};
function date(value?: string, timeZone = 'Europe/Zurich') {
  if (!value || !Number.isFinite(Date.parse(value))) return '–';
  try {
    return new Intl.DateTimeFormat('de-CH', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value));
  } catch {
    return '–';
  }
}
function failure(error: Error | null | undefined, fallback: string): string {
  const response = error as (Error & { response?: { data?: { error?: string } } }) | null;
  return response?.response?.data?.error || fallback;
}

function PersonalSettings({
  status,
  onClose,
}: {
  status: MailWorkspaceStatus;
  onClose: () => void;
}) {
  const t = useLocalize();
  const actions = useMailActions();
  const [form, setForm] = useState<MailWorkspaceSettings>(() => structuredClone(status.settings));
  const [accepted, setAccepted] = useState(status.settings.consentVersion === consentVersion);
  const [disconnect, setDisconnect] = useState(false);
  const [connectError, setConnectError] = useState(false);
  const busy =
    actions.settings.isLoading || actions.connect.isLoading || actions.disconnect.isLoading;
  const update = (next: Partial<MailWorkspaceSettings>) => setForm((old) => ({ ...old, ...next }));
  const connect = async () => {
    setConnectError(false);
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    try {
      const value = await actions.connect.mutateAsync();
      const url = new URL(value.authorizationUrl);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'login.microsoftonline.com' ||
        url.username ||
        url.password
      )
        throw new Error();
      if (popup) popup.location.replace(url.href);
      else window.location.assign(url.href);
    } catch {
      popup?.close();
      setConnectError(true);
    }
  };
  return (
    <aside className="mail-settings" aria-label={t('com_ui_mail_settings')}>
      <div className="mail-settings-heading">
        <h2>{t('com_ui_mail_settings')}</h2>
        <button className="mail-button" onClick={onClose}>
          {t('com_ui_mail_close')}
        </button>
      </div>
      <section>
        <h3>{t('com_ui_mail_connection')}</h3>
        <p className="mail-address">{status.connection.mailbox || t('com_ui_mail_disconnected')}</p>
        {status.connection.connected ? (
          <>
            {disconnect ? (
              <div className="mail-notice">
                <p>{t('com_ui_mail_disconnect_explain')}</p>
                <button
                  className="mail-button"
                  disabled={busy}
                  onClick={() => actions.disconnect.mutate(undefined, { onSuccess: onClose })}
                >
                  {t('com_ui_mail_disconnect_confirm')}
                </button>
                <button className="mail-button" onClick={() => setDisconnect(false)}>
                  {t('com_ui_mail_cancel')}
                </button>
              </div>
            ) : (
              <button className="mail-button" onClick={() => setDisconnect(true)}>
                {t('com_ui_mail_disconnect')}
              </button>
            )}
          </>
        ) : (
          <button className="mail-button primary" disabled={busy} onClick={() => void connect()}>
            {t('com_ui_mail_connect')}
          </button>
        )}
        {connectError && (
          <p role="alert" className="mail-error">
            {t('com_ui_mail_connect_error')}
          </p>
        )}
      </section>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          actions.settings.mutate(
            { ...form, consentVersion: accepted ? consentVersion : undefined },
            { onSuccess: onClose },
          );
        }}
      >
        <h3>{t('com_ui_mail_processing')}</h3>
        <p className="mail-model">{status.modelLabel}</p>
        <p className="mail-muted">{t('com_ui_mail_privacy')}</p>
        <label className="mail-check">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          {t('com_ui_mail_consent')}
        </label>
        <label className="mail-check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          {t('com_ui_mail_enable')}
        </label>
        <label>
          {t('com_ui_mail_history')}
          <select
            value={form.history?.mode || 'off'}
            onChange={(event) =>
              update({
                history: {
                  mode: event.target.value as 'off' | 'since' | 'all',
                  ...(event.target.value === 'since' && {
                    from: form.history?.from || new Date().toISOString().slice(0, 10),
                  }),
                },
              })
            }
          >
            <option value="off">{t('com_ui_mail_history_off')}</option>
            <option value="since">{t('com_ui_mail_history_since')}</option>
            <option value="all">{t('com_ui_mail_history_all')}</option>
          </select>
        </label>
        {form.history?.mode === 'since' && (
          <label>
            {t('com_ui_mail_since')}
            <input
              type="date"
              required
              value={form.history.from?.slice(0, 10) || ''}
              onChange={(event) => update({ history: { mode: 'since', from: event.target.value } })}
            />
          </label>
        )}
        <label>
          {t('com_ui_mail_execution')}
          <select
            value={form.mode}
            onChange={(event) => update({ mode: event.target.value as 'manual' | 'scheduled' })}
          >
            <option value="manual">{t('com_ui_mail_manual')}</option>
            <option value="scheduled">{t('com_ui_mail_scheduled')}</option>
          </select>
        </label>
        {form.mode === 'scheduled' && (
          <>
            <fieldset>
              <legend>{t('com_ui_mail_weekdays')}</legend>
              <div className="mail-days">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={form.weekdays.includes(day)}
                      onChange={(event) =>
                        update({
                          weekdays: event.target.checked
                            ? [...form.weekdays, day]
                            : form.weekdays.filter((d) => d !== day),
                        })
                      }
                    />
                    {t(`com_ui_mail_day_${day}` as TranslationKeys)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mail-time">
              <label>
                {t('com_ui_mail_start')}
                <input
                  type="time"
                  required
                  value={form.startTime}
                  onChange={(event) => update({ startTime: event.target.value })}
                />
              </label>
              <label>
                {t('com_ui_mail_end')}
                <input
                  type="time"
                  required
                  value={form.endTime}
                  onChange={(event) => update({ endTime: event.target.value })}
                />
              </label>
            </div>
            <label>
              {t('com_ui_mail_timezone')}
              <input
                value={form.timeZone}
                required
                onChange={(event) => update({ timeZone: event.target.value })}
              />
            </label>
            <label>
              {t('com_ui_mail_interval')}
              <select
                value={form.intervalMinutes}
                onChange={(event) =>
                  update({ intervalMinutes: Number(event.target.value) as 15 | 30 | 60 })
                }
              >
                {[15, 30, 60].map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t('com_ui_mail_minutes', { count: minutes })}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <p className="mail-muted">{t('com_ui_mail_batch_hint')}</p>
        <button
          className="mail-button primary"
          type="submit"
          disabled={busy || (form.enabled && (!accepted || !status.connection.connected))}
        >
          {t('com_ui_mail_save_settings')}
        </button>
        {(actions.settings.isError || actions.disconnect.isError) && (
          <p className="mail-error" role="alert">
            {failure(
              (actions.settings.error || actions.disconnect.error) as Error,
              t('com_ui_mail_error'),
            )}
          </p>
        )}
      </form>
    </aside>
  );
}

function FolderPicker({
  active,
  chosen,
  onChoose,
  onClose,
}: {
  active: boolean;
  chosen: MailWorkspaceFolder | null;
  onChoose: (folder: MailWorkspaceFolder) => void;
  onClose: () => void;
}) {
  const t = useLocalize();
  const [parents, setParents] = useState<MailWorkspaceFolder[]>([]);
  const folders = useMailFolders(active, parents.at(-1)?.id);
  return (
    <div className="mail-folder-picker" role="dialog" aria-label={t('com_ui_mail_choose_folder')}>
      <div className="mail-settings-heading">
        <h3>{t('com_ui_mail_choose_folder')}</h3>
        <button className="mail-button" onClick={onClose}>
          {t('com_ui_mail_close')}
        </button>
      </div>
      <p className="mail-muted">{t('com_ui_mail_folder_hint')}</p>
      <div className="mail-folder-path">
        <button
          className="mail-button"
          disabled={!parents.length}
          onClick={() => setParents((old) => old.slice(0, -1))}
        >
          <ArrowLeft size={15} />
          {t('com_ui_mail_back')}
        </button>
        <span>{parents.map((p) => p.displayName).join(' / ') || t('com_ui_mail_mailbox')}</span>
      </div>
      {folders.isLoading ? (
        <p role="status">{t('com_ui_mail_loading')}</p>
      ) : (
        <ul>
          {folders.data?.folders.map((folder) => (
            <li key={folder.id}>
              <button
                className="mail-folder-name"
                disabled={!folder.canMoveTo}
                onClick={() => {
                  onChoose({
                    ...folder,
                    path: [...parents.map((p) => p.displayName), folder.displayName].join(' / '),
                  });
                  onClose();
                }}
              >
                <FolderCheck size={16} />
                {folder.displayName}
                {chosen?.id === folder.id && <Check size={15} />}
              </button>
              {!!folder.childFolderCount && (
                <button
                  className="mail-button"
                  title={t('com_ui_mail_subfolders')}
                  aria-label={`${folder.displayName}: ${t('com_ui_mail_subfolders')}`}
                  onClick={() => setParents((old) => [...old, folder])}
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {folders.isError && (
        <p className="mail-error" role="alert">
          {failure(folders.error as Error, t('com_ui_mail_error'))}
        </p>
      )}
    </div>
  );
}

function Detail({
  result,
  status,
  onMoved,
}: {
  result: MailWorkspaceResult;
  status: MailWorkspaceStatus;
  onMoved: () => void;
}) {
  const t = useLocalize();
  const { user } = useAuthContext();
  const { newConversation } = useNewConvo();
  const navigate = useNavigate();
  const content = useMailContent(result.id, result.revision);
  const actions = useMailActions();
  const [tab, setTab] = useState<'message' | 'draft'>('message');
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [revision, setRevision] = useState('');
  const [notice, setNotice] = useState('');
  const [folderPicker, setFolderPicker] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const folderKey = `mail:done-folder:${user?.id}:${status.connection.mailbox}`;
  const [folder, setFolder] = useState<MailWorkspaceFolder | null>(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(folderKey) || 'null',
      ) as MailWorkspaceFolder | null;
      return stored?.id && stored.displayName ? stored : null;
    } catch {
      return null;
    }
  });
  const data =
    content.data?.resultId === result.id &&
    content.data.mailbox.toLowerCase() === status.connection.mailbox?.toLowerCase()
      ? content.data
      : undefined;
  const busy = actions.move.isLoading || actions.draft.isLoading || actions.priority.isLoading;
  const locked = status.settings.consentVersion !== consentVersion;
  const selectedBody = tab === 'draft' ? data?.draft : data?.message;
  const chooseFolder = (next: MailWorkspaceFolder) => {
    setFolder(next);
    localStorage.setItem(folderKey, JSON.stringify(next));
  };
  const startChat = () => {
    if (!data || !user?.id) return;
    const draft = editing ? body : data.draft?.replyText || data.draft?.body || '';
    const text = t('com_ui_mail_chat_prompt', {
      subject: data.message.subject,
      sender: data.message.sender,
      mailbox: data.mailbox,
      original: data.message.body,
      draft,
      questions: result.questions.join('\n'),
    });
    const token = prepareMailChat(user.id, text);
    newConversation();
    navigate(`/c/new?mailReview=${encodeURIComponent(token)}`);
  };
  return (
    <article className="mail-detail" aria-label={t('com_ui_mail_detail')}>
      <header className="mail-detail-heading">
        <div className="mail-detail-kicker">
          <span className={`mail-priority ${result.priority}`}>
            {t(priorities[result.priority])}
          </span>
          <span>{date(result.receivedAt, status.settings.timeZone)}</span>
          {result.moveStatus === 'completed' && (
            <span className="mail-done">
              <Check size={13} />
              {t('com_ui_mail_done')}
            </span>
          )}
        </div>
        <h2>{result.subject || t('com_ui_mail_no_subject')}</h2>
        <p className="mail-address">{result.sender}</p>
      </header>
      <div className="mail-detail-tools">
        <label className="mail-inline-label">
          {t('com_ui_mail_priority')}
          <select
            value={result.priority}
            disabled={busy || locked}
            onChange={(event) =>
              actions.priority.mutate({
                id: result.id,
                priority: event.target.value as MailWorkspacePriority,
              })
            }
          >
            {Object.entries(priorities).map(([key, label]) => (
              <option key={key} value={key}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
        <button className="mail-button" onClick={() => setFolderPicker(true)}>
          {folder?.displayName || t('com_ui_mail_choose_folder')}
        </button>
        <button
          className="mail-button"
          disabled={
            busy ||
            locked ||
            !folder ||
            result.moveStatus === 'completed' ||
            result.moveStatus === 'uncertain'
          }
          onClick={() => setConfirmMove(true)}
        >
          <FolderCheck size={16} />
          {t('com_ui_mail_mark_done')}
        </button>
      </div>
      {folderPicker && (
        <FolderPicker
          active={status.connection.connected}
          chosen={folder}
          onChoose={chooseFolder}
          onClose={() => setFolderPicker(false)}
        />
      )}
      {confirmMove && (
        <div className="mail-notice">
          <p>
            {t('com_ui_mail_move_confirm', {
              folder: folder?.path || folder?.displayName,
              subject: result.subject,
            })}
          </p>
          <button
            className="mail-button primary"
            disabled={busy}
            onClick={() =>
              folder &&
              actions.move.mutate(
                { id: result.id, folderId: folder.id, revision: result.revision },
                {
                  onSuccess: () => {
                    setConfirmMove(false);
                    onMoved();
                  },
                },
              )
            }
          >
            {t('com_ui_mail_move_now')}
          </button>
          <button className="mail-button" disabled={busy} onClick={() => setConfirmMove(false)}>
            {t('com_ui_mail_cancel')}
          </button>
        </div>
      )}
      {result.moveStatus === 'uncertain' && (
        <p className="mail-notice">{t('com_ui_mail_move_uncertain')}</p>
      )}
      {result.draftWarnings?.length ? (
        <div className="mail-notice">
          <ul>
            {result.draftWarnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <section className="mail-summary">
        <div className="mail-summary-heading">
          <h3>{t('com_ui_mail_summary')}</h3>
          <span>{t(draftStates[result.draftStatus])}</span>
        </div>
        <p>{result.summary}</p>
        {result.questions.length > 0 && (
          <div className="mail-questions">
            <h4>{t('com_ui_mail_questions')}</h4>
            <ul>
              {result.questions.map((question, i) => (
                <li key={i}>{question}</li>
              ))}
            </ul>
            <p>{t('com_ui_mail_questions_private')}</p>
          </div>
        )}
        <details>
          <summary>{t('com_ui_mail_reason')}</summary>
          <p>{result.reason}</p>
        </details>
      </section>
      <div className="mail-tabs" role="tablist" aria-label={t('com_ui_mail_content')}>
        <button role="tab" aria-selected={tab === 'message'} onClick={() => setTab('message')}>
          {t('com_ui_mail_original')}
        </button>
        <button role="tab" aria-selected={tab === 'draft'} onClick={() => setTab('draft')}>
          {t('com_ui_mail_draft')}
        </button>
        <button
          className="mail-button mail-chat-button"
          disabled={!data || busy}
          onClick={startChat}
        >
          <MessageSquare size={15} />
          {t('com_ui_mail_chat')}
        </button>
      </div>
      {content.isLoading && (
        <div className="mail-empty" role="status">
          <Loader2 className="animate-spin" size={24} />
          {t('com_ui_mail_loading')}
        </div>
      )}
      {content.isError && (
        <p className="mail-error" role="alert">
          {failure(content.error as Error, t('com_ui_mail_content_error'))}
          <button className="mail-button" onClick={() => void content.refetch()}>
            {t('com_ui_mail_retry')}
          </button>
        </p>
      )}
      {data && !selectedBody && <p className="mail-empty">{t('com_ui_mail_draft_unavailable')}</p>}
      {selectedBody && (
        <section className="mail-body">
          <div className="mail-body-actions">
            {tab === 'draft' && !editing && (
              <button
                className="mail-button"
                disabled={!data?.draft?.revision || data.draft.replyText === undefined || locked}
                onClick={() => {
                  setBody(data?.draft?.replyText || '');
                  setRevision(data?.draft?.revision || '');
                  setEditing(true);
                }}
              >
                <FileText size={15} />
                {t('com_ui_mail_edit')}
              </button>
            )}
            <button
              className="mail-button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(editing && tab === 'draft' ? body : selectedBody.body)
                  .then(() => setNotice(t('com_ui_mail_copied')))
                  .catch(() => setNotice(t('com_ui_mail_copy_error')))
              }
            >
              <Copy size={15} />
              {t('com_ui_mail_copy')}
            </button>
            {notice && <span role="status">{notice}</span>}
          </div>
          {tab === 'draft' && editing ? (
            <>
              <label className="mail-edit-label">
                {t('com_ui_mail_edit_hint')}
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={18}
                  maxLength={12000}
                />
              </label>
              <div className="mail-body-actions">
                <button
                  className="mail-button primary"
                  disabled={!body.trim() || busy || locked}
                  onClick={() =>
                    actions.draft.mutate(
                      { id: result.id, body, revision },
                      {
                        onSuccess: () => {
                          setEditing(false);
                          setNotice(t('com_ui_mail_saved'));
                        },
                      },
                    )
                  }
                >
                  <Save size={15} />
                  {t('com_ui_mail_save_draft')}
                </button>
                <button className="mail-button" disabled={busy} onClick={() => setEditing(false)}>
                  {t('com_ui_mail_cancel')}
                </button>
              </div>
            </>
          ) : (
            <pre>{selectedBody.body || t('com_ui_mail_empty_body')}</pre>
          )}
          {selectedBody.bodyTruncated && (
            <p className="mail-notice">{t('com_ui_mail_truncated')}</p>
          )}
          {tab === 'draft' && !data?.draft?.revision && (
            <p className="mail-muted">{t('com_ui_mail_legacy_draft')}</p>
          )}
        </section>
      )}
      {(actions.move.isError || actions.draft.isError || actions.priority.isError) && (
        <p className="mail-error" role="alert">
          {failure(
            (actions.move.error || actions.draft.error || actions.priority.error) as Error,
            t('com_ui_mail_error'),
          )}
        </p>
      )}
      <footer className="mail-detail-footer">{t('com_ui_mail_never_send')}</footer>
    </article>
  );
}

function MailWorkspace() {
  const t = useLocalize();
  const statusQuery = useMailStatus();
  const status = statusQuery.data;
  const actions = useMailActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<MailWorkspacePriority | ''>('');
  const [state, setState] = useState<'open' | 'done' | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const resultQuery = useMailResults(
    { search: query, priority: priority || undefined, state },
    !!status?.available && !!status?.connection.connected,
  );
  const rows = useMemo(
    () => resultQuery.data?.pages.flatMap((page) => page.results) || [],
    [resultQuery.data],
  );
  const selected = rows.find((row) => row.id === selectedId);
  const previousRunning = useRef(false);
  const running = !!status?.activity.running || !!status?.activity.continuing;
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setSelectedId(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const refreshResults = resultQuery.refetch;
  useEffect(() => {
    if (previousRunning.current && !running) void refreshResults();
    previousRunning.current = running;
  }, [running, refreshResults]);
  return (
    <main className="mail-workspace">
      <header className="mail-workspace-heading">
        <div className="mail-heading-title">
          <div className="mail-heading-icon">
            <Mail size={22} />
          </div>
          <div>
            <h1>{t('com_ui_mail_workspace')}</h1>
            <p>{status?.connection.mailbox || t('com_ui_mail_tagline')}</p>
          </div>
        </div>
        <div className="mail-heading-actions">
          <button
            className="mail-button"
            onClick={() => void actions.refresh()}
            aria-label={t('com_ui_mail_refresh')}
          >
            <RefreshCw size={16} />
          </button>
          <button className="mail-button" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} />
            {t('com_ui_mail_settings')}
          </button>
          {running ? (
            <button
              className="mail-button"
              disabled={actions.pause.isLoading}
              onClick={() => actions.pause.mutate()}
            >
              <Pause size={16} />
              {t('com_ui_mail_pause')}
            </button>
          ) : (
            <button
              className="mail-button primary"
              disabled={
                !status?.available ||
                !status.connection.connected ||
                !status.settings.enabled ||
                status.settings.consentVersion !== consentVersion ||
                actions.run.isLoading
              }
              onClick={() =>
                actions.run.mutate(undefined, {
                  onSuccess: () => setNotice(t('com_ui_mail_started')),
                })
              }
            >
              <Play size={16} />
              {t('com_ui_mail_check_now')}
            </button>
          )}
        </div>
      </header>
      <div className="mail-progress" role="status">
        <span className={`mail-status-dot ${running ? 'running' : ''}`} />
        {running ? t('com_ui_mail_running') : t('com_ui_mail_ready')}
        <span className="mail-progress-detail">
          {status?.activity.history.mode !== 'off' &&
          status?.activity.history.processed !== undefined
            ? t('com_ui_mail_processed', { count: status.activity.history.processed })
            : ''}
        </span>
        <span className="mail-progress-detail">
          {status?.activity.lastRunAt
            ? t('com_ui_mail_last_check', {
                time: date(status.activity.lastRunAt, status.settings.timeZone),
              })
            : ''}
        </span>
      </div>
      {status?.connection.connected && status.settings.consentVersion !== consentVersion && (
        <p className="mail-banner">
          <span>{t('com_ui_mail_consent_update')}</span>
          <button className="mail-button" onClick={() => setSettingsOpen(true)}>
            {t('com_ui_mail_settings')}
          </button>
        </p>
      )}
      {notice && (
        <p className="mail-banner" role="status">
          {notice}
          <button onClick={() => setNotice('')} aria-label={t('com_ui_mail_close')}>
            ×
          </button>
        </p>
      )}
      {(statusQuery.isError ||
        actions.run.isError ||
        actions.pause.isError ||
        status?.activity.lastError) && (
        <p className="mail-banner mail-error" role="alert">
          {status?.activity.lastError ||
            failure(
              (statusQuery.error || actions.run.error || actions.pause.error) as Error,
              t('com_ui_mail_error'),
            )}
        </p>
      )}
      {statusQuery.isLoading && (
        <div className="mail-empty" role="status">
          <Loader2 className="animate-spin" />
          {t('com_ui_mail_loading')}
        </div>
      )}
      {!statusQuery.isLoading && (!status?.available || !status.connection.connected) && (
        <div className="mail-empty">
          <Mail size={42} />
          <h2>{t('com_ui_mail_welcome')}</h2>
          <p>{status?.reason || t('com_ui_mail_welcome_hint')}</p>
          <button className="mail-button primary" onClick={() => setSettingsOpen(true)}>
            {t('com_ui_mail_settings')}
          </button>
        </div>
      )}
      {!statusQuery.isLoading && status?.available && status.connection.connected && (
        <>
          <div className="mail-filterbar">
            <label className="mail-search">
              <Search size={17} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('com_ui_mail_search')}
                aria-label={t('com_ui_mail_search')}
              />
            </label>
            <select
              aria-label={t('com_ui_mail_priority')}
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as MailWorkspacePriority | '');
                setSelectedId(null);
              }}
            >
              <option value="">{t('com_ui_mail_all_priorities')}</option>
              {Object.entries(priorities).map(([key, label]) => (
                <option key={key} value={key}>
                  {t(label)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('com_ui_mail_state')}
              value={state}
              onChange={(event) => {
                setState(event.target.value as 'open' | 'done' | 'all');
                setSelectedId(null);
              }}
            >
              <option value="open">{t('com_ui_mail_open')}</option>
              <option value="done">{t('com_ui_mail_done')}</option>
              <option value="all">{t('com_ui_mail_all')}</option>
            </select>
            <span className="mail-count">{t('com_ui_mail_loaded', { count: rows.length })}</span>
          </div>
          <div className={`mail-columns ${selected ? 'has-selection' : ''}`}>
            <section className="mail-list" aria-label={t('com_ui_mail_list')}>
              <div className="mail-list-heading">
                <span>{t('com_ui_mail_newest')}</span>
                <span>{t('com_ui_mail_priority')}</span>
              </div>
              {resultQuery.isLoading && (
                <p className="mail-empty" role="status">
                  {t('com_ui_mail_loading')}
                </p>
              )}
              {!resultQuery.isLoading && rows.length === 0 && (
                <div className="mail-empty">
                  <Mail size={28} />
                  <p>{t('com_ui_mail_no_results')}</p>
                </div>
              )}
              <ul>
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      className={`mail-row ${row.id === selectedId ? 'selected' : ''}`}
                      onClick={() => setSelectedId(row.id)}
                      aria-pressed={row.id === selectedId}
                    >
                      <div className="mail-row-top">
                        <span className="mail-row-sender">{row.sender}</span>
                        <time>{date(row.receivedAt, status.settings.timeZone)}</time>
                      </div>
                      <div className="mail-row-subject">
                        {row.subject || t('com_ui_mail_no_subject')}
                      </div>
                      <p>{row.summary}</p>
                      <div className="mail-row-bottom">
                        <span className={`mail-priority ${row.priority}`}>
                          {t(priorities[row.priority])}
                        </span>
                        <span>
                          {row.moveStatus === 'completed'
                            ? t('com_ui_mail_done')
                            : t(draftStates[row.draftStatus])}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {resultQuery.hasNextPage && (
                <button
                  className="mail-button mail-load-more"
                  disabled={resultQuery.isFetchingNextPage}
                  onClick={() => void resultQuery.fetchNextPage()}
                >
                  {resultQuery.isFetchingNextPage
                    ? t('com_ui_mail_loading')
                    : t('com_ui_mail_load_more')}
                </button>
              )}
              {resultQuery.isError && (
                <p className="mail-error" role="alert">
                  {failure(resultQuery.error as Error, t('com_ui_mail_error'))}
                </p>
              )}
            </section>
            <div className="mail-detail-container">
              {selected ? (
                <>
                  <button
                    className="mail-mobile-back mail-button"
                    onClick={() => setSelectedId(null)}
                  >
                    <ArrowLeft size={16} />
                    {t('com_ui_mail_list')}
                  </button>
                  <Detail
                    key={`${selected.id}:${selected.revision}`}
                    result={selected}
                    status={status}
                    onMoved={() => {
                      setNotice(t('com_ui_mail_moved'));
                      setSelectedId(null);
                    }}
                  />
                </>
              ) : (
                <div className="mail-empty mail-selection-empty">
                  <div className="mail-empty-icon">
                    <Mail size={32} />
                  </div>
                  <h2>{t('com_ui_mail_select')}</h2>
                  <p>{t('com_ui_mail_select_hint')}</p>
                  <p className="mail-muted">{t('com_ui_mail_never_send')}</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {settingsOpen && status && (
        <div className="mail-settings-overlay">
          <PersonalSettings status={status} onClose={() => setSettingsOpen(false)} />
        </div>
      )}
    </main>
  );
}
export default function Workspace() {
  const { user } = useAuthContext();
  return user?.id ? <MailWorkspace key={user.id} /> : null;
}
