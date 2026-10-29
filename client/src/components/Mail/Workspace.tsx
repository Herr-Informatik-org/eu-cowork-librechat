import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Mail,
  Search,
  RefreshCw,
  Settings2,
  Play,
  Pause,
  Check,
  ArrowLeft,
  MessageSquare,
  Copy,
  Save,
  FolderCheck,
  FileText,
  Loader2,
  Keyboard,
  Reply,
  Forward,
} from 'lucide-react';
import type {
  MailWorkspaceResult,
  MailWorkspacePriority,
  MailWorkspaceStatus,
  MailWorkspaceSettings,
  MailWorkspaceFolder,
  MailWorkspaceContent,
} from 'librechat-data-provider';
import {
  useMailStatus,
  useMailResults,
  useMailContent,
  useMailActions,
  useMailMoveJobs,
  useMailInbox,
} from '~/data-provider/Mail';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useAuthContext, useLocalize } from '~/hooks';
import {
  isMailEscape,
  isMailSubmitShortcut,
  mailShortcutKey,
  ShortcutHelp,
  trapMailDialogFocus,
} from './Shortcuts';
import { MailFollowupSettings, MailFollowupAction } from './Followup';
import { MailDraftRequest, safeOutlookDraftUrl } from './DraftRequest';
import { MailAttachments } from './Attachments';
import MailRecipients from './Recipients';
import { MailResearch, MailResearchProgress } from './Research';
import { MailChat, MailCorrespondence, emptyMailChat } from './Chat';
import type { MailChatState } from './Chat';
import { MailSignatureSettings } from './Signature';
import { FolderPicker, useDoneFolder } from './Folders';
import MailImages from './Images';
import { MoveProgress, isMoveActive } from './Operations';
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

function ResponseAction({
  value,
  timeZone,
}: {
  value: Pick<MailWorkspaceResult, 'responseAction' | 'responseActionAt'>;
  timeZone: string;
}) {
  const t = useLocalize();
  if (value.responseAction !== 'replied' && value.responseAction !== 'forwarded') return null;
  const label = t(
    value.responseAction === 'replied' ? 'com_ui_mail_replied' : 'com_ui_mail_forwarded',
  );
  const timestamp = value.responseActionAt;
  const description =
    timestamp && Number.isFinite(Date.parse(timestamp))
      ? `${label} · ${date(timestamp, timeZone)}`
      : label;
  return (
    <span className="mail-response-action" role="img" aria-label={description} title={description}>
      {value.responseAction === 'replied' ? (
        <Reply size={14} aria-hidden="true" />
      ) : (
        <Forward size={14} aria-hidden="true" />
      )}
    </span>
  );
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
  const settingsPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    settingsPanel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
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
    <aside
      ref={settingsPanel}
      className="mail-settings"
      role="dialog"
      aria-modal="true"
      data-mail-shortcuts="off"
      aria-label={t('com_ui_mail_settings')}
      onKeyDown={(event) => {
        if (isMailEscape(event)) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        trapMailDialogFocus(event);
      }}
    >
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
        <MailSignatureSettings
          value={form.signature}
          onChange={(signature) => update({ signature })}
          disabled={busy}
        />
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
      {status.odooAvailable === true && <MailFollowupSettings />}
    </aside>
  );
}

type DraftEditor = {
  result: MailWorkspaceResult;
  content: MailWorkspaceContent;
  body: string;
  revision: string;
};

type MailDetailControls = {
  reply: () => void;
  chat: () => void;
  outlook: () => void;
  original: () => void;
  draft: () => void;
  attachments: () => void;
  correspondence: () => void;
  research: () => void;
};

const Detail = forwardRef<
  MailDetailControls,
  {
    result: MailWorkspaceResult;
    status: MailWorkspaceStatus;
    folder: MailWorkspaceFolder | null;
    onMove: (items: MailWorkspaceResult[]) => void;
    moveUnavailable: boolean;
    editor?: DraftEditor;
    onEditorChange: (editor?: DraftEditor) => void;
    chatState: MailChatState;
    onChatChange: (update: (previous: MailChatState) => MailChatState) => void;
    onOpen: (result: MailWorkspaceResult) => void;
  }
>(function Detail(
  {
    result,
    status,
    folder,
    onMove,
    moveUnavailable,
    editor,
    onEditorChange,
    chatState,
    onChatChange,
    onOpen,
  },
  ref,
) {
  const t = useLocalize();
  const content = useMailContent(result.id, result.revision);
  const actions = useMailActions();
  const [tab, setTab] = useState<'message' | 'draft' | 'chat'>(editor ? 'draft' : 'message');
  const editing = !!editor;
  const body = editor?.body || '';
  const revision = editor?.revision || '';
  const [notice, setNotice] = useState('');
  const [draftOpenRequest, setDraftOpenRequest] = useState(0);
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const [researchOpenRequest, setResearchOpenRequest] = useState(0);
  const [instructionRequest, setInstructionRequest] = useState<{ id: number; text: string }>();
  const editorInput = useRef<HTMLTextAreaElement>(null);
  const detail = useRef<HTMLElement>(null);
  const draftSaving = useRef(false);
  const originalTab = useRef<HTMLButtonElement>(null);
  const draftTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing && tab === 'draft') editorInput.current?.focus();
  }, [editing, tab]);
  const currentContent =
    content.data?.resultId === result.id &&
    content.data.mailbox.toLowerCase() === status.connection.mailbox?.toLowerCase()
      ? content.data
      : undefined;
  const displayedContent = editor?.content || content.data;
  const data =
    displayedContent?.resultId === result.id &&
    displayedContent.mailbox.toLowerCase() === status.connection.mailbox?.toLowerCase()
      ? displayedContent
      : undefined;
  const busy = actions.draft.isLoading || actions.priority.isLoading;
  const locked =
    status.settings.consentVersion !== consentVersion || result.mailboxLocation === 'sent';
  const selectedBody = tab === 'draft' ? data?.draft : data?.message;
  const startChat = () => {
    if (!data) return;
    setTab('chat');
    setChatFocusRequest((value) => value + 1);
  };
  const openDetails = (selector: string) => {
    const section = detail.current?.querySelector<HTMLDetailsElement>(selector);
    if (!section) return;
    section.open = true;
    section.querySelector<HTMLElement>('summary')?.focus();
    section.scrollIntoView?.({ block: 'nearest' });
  };
  const saveDraft = () => {
    if (!editing || !body.trim() || busy || locked || draftSaving.current) return;
    draftSaving.current = true;
    actions.draft.mutate(
      { id: result.id, body, revision },
      {
        onSuccess: () => {
          onEditorChange();
          setNotice(t('com_ui_mail_saved'));
          draftTab.current?.focus();
        },
        onSettled: () => {
          draftSaving.current = false;
        },
      },
    );
  };
  useImperativeHandle(ref, () => ({
    reply: () => {
      if (locked || busy || !data) return;
      if (editing) {
        setTab('draft');
        editorInput.current?.focus();
        return;
      }
      if (data.draft?.revision && data.draft.replyText !== undefined) {
        setTab('draft');
        onEditorChange({
          result,
          content: data,
          body: data.draft.replyText,
          revision: data.draft.revision,
        });
        return;
      }
      setDraftOpenRequest((value) => value + 1);
    },
    chat: startChat,
    research: () => {
      if (data && !locked) setResearchOpenRequest((value) => value + 1);
    },
    original: () => {
      setTab('message');
      originalTab.current?.focus();
    },
    draft: () => {
      setTab('draft');
      draftTab.current?.focus();
    },
    attachments: () => openDetails('.mail-attachments'),
    correspondence: () => openDetails('.mail-correspondence'),
    outlook: () => {
      if (editing) return;
      const url = safeOutlookDraftUrl(data?.draft?.url);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
  }));
  const summary = (
    <>
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
    </>
  );
  return (
    <article
      ref={detail}
      className={`mail-detail ${tab === 'chat' ? 'mail-detail-chat' : ''}`}
      aria-label={t('com_ui_mail_detail')}
    >
      <header className="mail-detail-heading">
        <div className="mail-detail-kicker">
          <ResponseAction
            value={currentContent ? currentContent.message : result}
            timeZone={status.settings.timeZone}
          />
          <span className={`mail-priority ${result.priority}`}>
            {t(
              result.analysisStatus === 'pending'
                ? 'com_ui_mail_not_analyzed'
                : priorities[result.priority],
            )}
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
        <MailRecipients
          message={currentContent?.message}
          sender={result.sender}
          loading={content.isLoading || content.isFetching}
        />
        {(currentContent?.message.responseAction || result.responseAction) === 'forwarded' && (
          <p className="mail-muted">
            {t('com_ui_mail_forwarded')} ·{' '}
            {date(
              currentContent?.message.responseActionAt || result.responseActionAt,
              status.settings.timeZone,
            )}{' '}
            · {t('com_ui_mail_forwarded_recipient_unknown')}
          </p>
        )}
      </header>
      <div className="mail-detail-tools">
        <label className="mail-inline-label">
          {t('com_ui_mail_priority')}
          <select
            value={result.priority}
            disabled={busy || locked || editing}
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
        <button
          className="mail-button"
          disabled={
            busy ||
            locked ||
            !folder ||
            editing ||
            moveUnavailable ||
            result.moveStatus === 'completed' ||
            result.moveStatus === 'uncertain'
          }
          onClick={() => onMove([result])}
        >
          <FolderCheck size={16} />
          {t('com_ui_mail_mark_done')}
        </button>
        {result.mailboxLocation !== 'sent' && (
          <MailDraftRequest
            result={result}
            content={data}
            editing={editing}
            disabled={locked || busy || !data}
            openRequest={draftOpenRequest}
            instructionRequest={instructionRequest}
          />
        )}
        {status.odooAvailable === true && <MailFollowupAction result={result} />}
      </div>
      <MailResearch
        result={result}
        disabled={locked || !currentContent}
        openRequest={researchOpenRequest}
        transferDisabled={
          editing || busy || result.draftStatus === 'uncertain' || result.mailboxLocation === 'sent'
        }
        onUse={(text) => {
          setInstructionRequest((previous) => ({ id: (previous?.id || 0) + 1, text }));
          detail.current
            ?.querySelector<HTMLElement>('.mail-draft-request')
            ?.scrollIntoView({ block: 'nearest' });
        }}
      />
      {editing && <p className="mail-notice">{t('com_ui_mail_edit_before_move')}</p>}
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
      {result.analysisStatus !== 'pending' &&
        (tab === 'chat' ? (
          <details className="mail-summary mail-summary-compact">
            <summary>
              {t('com_ui_mail_summary')} · {result.summary}
            </summary>
            {summary}
          </details>
        ) : (
          <section className="mail-summary">{summary}</section>
        ))}
      <div
        className="mail-tabs"
        role="tablist"
        aria-label={t('com_ui_mail_content')}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            event.shiftKey ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          )
            return;
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
          );
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          event.stopPropagation();
          let nextIndex =
            (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          if (event.key === 'Home') nextIndex = 0;
          if (event.key === 'End') nextIndex = tabs.length - 1;
          const next = tabs[nextIndex];
          next?.focus();
          next?.click();
        }}
      >
        <button
          ref={originalTab}
          role="tab"
          aria-selected={tab === 'message'}
          onClick={() => setTab('message')}
        >
          {t('com_ui_mail_original')}
        </button>
        <button
          ref={draftTab}
          role="tab"
          aria-selected={tab === 'draft'}
          onClick={() => setTab('draft')}
        >
          {t('com_ui_mail_draft')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'chat'}
          className="mail-chat-button"
          disabled={!data}
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
      {tab === 'chat' && data && (
        <MailChat
          result={result}
          draft={editing ? body : data.draft?.replyText || data.draft?.body}
          state={chatState}
          onChange={onChatChange}
          onOpen={onOpen}
          focusRequest={chatFocusRequest}
          onApply={
            data.draft?.revision && data.draft.replyText !== undefined && !locked && !busy
              ? (text) => {
                  if (!data.draft?.revision || text.length > 12000) return;
                  onEditorChange({
                    result,
                    content: data,
                    body: text,
                    revision: data.draft.revision,
                  });
                  setTab('draft');
                }
              : undefined
          }
        />
      )}
      {tab !== 'chat' && data && !selectedBody && (
        <p className="mail-empty">{t('com_ui_mail_draft_unavailable')}</p>
      )}
      {tab !== 'chat' && selectedBody && (
        <section className="mail-body">
          <div className="mail-body-actions">
            {tab === 'draft' && !editing && (
              <button
                className="mail-button"
                disabled={!data?.draft?.revision || data.draft.replyText === undefined || locked}
                onClick={() => {
                  if (!data?.draft?.revision || data.draft.replyText === undefined) return;
                  onEditorChange({
                    result,
                    content: data,
                    body: data.draft.replyText,
                    revision: data.draft.revision,
                  });
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
                  ref={editorInput}
                  value={body}
                  disabled={busy}
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  onKeyDown={(event) => {
                    if (!isMailSubmitShortcut(event)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    saveDraft();
                  }}
                  onChange={(event) =>
                    editor && onEditorChange({ ...editor, body: event.target.value })
                  }
                  rows={18}
                  maxLength={12000}
                />
              </label>
              <p className="mail-muted">{t('com_ui_mail_editor_submit_shortcut')}</p>
              <div className="mail-body-actions">
                <button
                  className="mail-button primary"
                  disabled={!body.trim() || busy || locked}
                  onClick={saveDraft}
                >
                  <Save size={15} />
                  {t('com_ui_mail_save_draft')}
                </button>
                <button
                  className="mail-button"
                  disabled={busy}
                  onClick={() => {
                    onEditorChange();
                    draftTab.current?.focus();
                  }}
                >
                  {t('com_ui_mail_cancel')}
                </button>
              </div>
            </>
          ) : (
            <MailImages
              key={`${data?.mailbox}:${result.id}:${result.revision}:${tab}:${data?.draft?.revision || ''}`}
              id={result.id}
              revision={result.revision}
              kind={tab === 'draft' ? 'draft' : 'original'}
              preview={selectedBody.preview}
              text={selectedBody.body || t('com_ui_mail_empty_body')}
              title={tab === 'draft' ? t('com_ui_mail_draft') : t('com_ui_mail_original')}
            />
          )}
          {selectedBody.bodyTruncated && (
            <p className="mail-notice">
              {t(selectedBody.preview ? 'com_ui_mail_text_truncated' : 'com_ui_mail_truncated')}
            </p>
          )}
          {tab === 'draft' && !data?.draft?.revision && (
            <p className="mail-muted">{t('com_ui_mail_legacy_draft')}</p>
          )}
        </section>
      )}
      {(actions.draft.isError || actions.priority.isError) && (
        <p className="mail-error" role="alert">
          {failure(
            (actions.draft.error || actions.priority.error) as Error,
            t('com_ui_mail_error'),
          )}
        </p>
      )}

      <MailAttachments result={result} />
      <MailCorrespondence result={result} onOpen={onOpen} />
      <footer className="mail-detail-footer">{t('com_ui_mail_never_send')}</footer>
    </article>
  );
});

function MailWorkspace() {
  const t = useLocalize();
  const { user } = useAuthContext();
  const statusQuery = useMailStatus();
  const status = statusQuery.data;
  const actions = useMailActions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchReturnFocus = useRef(false);
  const workspace = useRef<HTMLElement>(null);
  const detailControls = useRef<MailDetailControls>(null);
  const moveSubmitting = useRef(false);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<MailWorkspacePriority | ''>('');
  const [state, setState] = useState<'open' | 'done' | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editors, setEditors] = useState<Record<string, DraftEditor>>({});
  const [pinned, setPinned] = useState<Record<string, MailWorkspaceResult>>({});
  const [chats, setChats] = useState<Record<string, MailChatState>>({});
  const chatScope = useRef(Symbol());
  const mailbox = status?.connection.connected
    ? status.connection.mailbox?.toLowerCase()
    : undefined;
  const currentEditor = (id: string) =>
    mailbox && editors[id]?.content.mailbox.toLowerCase() === mailbox ? editors[id] : undefined;
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState<Map<string, MailWorkspaceResult>>(new Map());
  const [folderPicker, setFolderPicker] = useState(false);
  const [moveFolderItems, setMoveFolderItems] = useState<MailWorkspaceResult[] | null>(null);
  const { folder, chooseFolder } = useDoneFolder(user?.id, status?.connection.mailbox);
  const jobsQuery = useMailMoveJobs(!!status?.available && !!status.connection.connected);
  const jobs = jobsQuery.data?.jobs || [];
  const moveUnavailable =
    actions.enqueueMove.isLoading ||
    !!jobsQuery.isLoading ||
    !!jobsQuery.isError ||
    jobs.some(isMoveActive);
  const mailboxAvailable = !!status?.available && !!status.connection.connected;
  const inboxMode = state === 'open';
  const inboxQuery = useMailInbox(mailboxAvailable && inboxMode);
  const analysisQuery = useMailResults(
    { search: query, priority: priority || undefined, state },
    mailboxAvailable && !inboxMode,
  );
  const resultQuery = inboxMode ? inboxQuery : analysisQuery;
  const loadedRows = useMemo(() => {
    const unique = new Map<string, MailWorkspaceResult>();
    for (const page of resultQuery.data?.pages || [])
      for (const row of page.results) unique.set(row.id, row);
    return Array.from(unique.values());
  }, [resultQuery.data]);
  const rows = useMemo(
    () =>
      inboxMode
        ? loadedRows.filter((row) => {
            if (priority && (row.analysisStatus === 'pending' || row.priority !== priority))
              return false;
            const text = query.trim().toLocaleLowerCase();
            return (
              !text ||
              `${row.sender} ${row.subject} ${row.summary}`.toLocaleLowerCase().includes(text)
            );
          })
        : loadedRows,
    [loadedRows, inboxMode, priority, query],
  );
  const editor = selectedId ? currentEditor(selectedId) : undefined;
  const selected =
    editor?.result ||
    loadedRows.find((row) => row.id === selectedId) ||
    (selectedId ? pinned[selectedId] : undefined);
  const activeChatScope = chatScope.current;
  const openMail = (row: MailWorkspaceResult) => {
    setPinned((previous) => ({ ...previous, [row.id]: row }));
    setSelectedId(row.id);
  };
  const selectionHasEditor = [...checked.keys()].some((id) => !!currentEditor(id));
  const eligible = rows.filter((row) => !row.moveStatus && row.mailboxLocation !== 'sent');
  const selectable = eligible.slice(0, 100);
  const allSelected = selectable.length > 0 && selectable.every((row) => checked.has(row.id));
  const tabRowId = rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id;
  const focusList = () => {
    const next = rows.find((row) => row.id === selectedId) || rows[0];
    if (!next) {
      workspace.current?.focus();
      return;
    }
    openMail(next);
    rowButtons.current.get(next.id)?.focus({ preventScroll: true });
    rowButtons.current.get(next.id)?.scrollIntoView?.({ block: 'nearest' });
  };
  const requestMove = (items: MailWorkspaceResult[], target = folder) => {
    if (
      !target ||
      moveUnavailable ||
      moveSubmitting.current ||
      items.some(
        (item) => !!item.moveStatus || item.mailboxLocation === 'sent' || !!currentEditor(item.id),
      ) ||
      !items.length ||
      items.length > 100 ||
      status?.settings.consentVersion !== consentVersion
    )
      return;
    const request = {
      requestId: crypto.randomUUID(),
      folderId: target.id,
      items: items.map(({ id, revision }) => ({ id, revision })),
    };
    moveSubmitting.current = true;
    actions.enqueueMove.mutate(request, {
      onSuccess: () => {
        setChecked((previous) => {
          const next = new Map(previous);
          for (const item of items) next.delete(item.id);
          return next;
        });
        const nextRow = rows.find(
          (row) => !items.some((item) => item.id === row.id) && !row.moveStatus,
        );
        const active = document.activeElement;
        if (
          active === workspace.current ||
          items.some((item) => rowButtons.current.get(item.id) === active)
        ) {
          setSelectedId((current) =>
            items.some((item) => item.id === current) ? nextRow?.id || null : current,
          );
          if (nextRow) {
            const button = rowButtons.current.get(nextRow.id);
            button?.focus({ preventScroll: true });
            button?.scrollIntoView?.({ block: 'nearest' });
          } else workspace.current?.focus();
        }
        setNotice(t('com_ui_mail_bulk_queued'));
      },
      onError: () => setNotice(t('com_ui_mail_job_submit_error')),
      onSettled: () => {
        moveSubmitting.current = false;
      },
    });
  };
  const previousRunning = useRef(false);
  const running = !!status?.activity.running || !!status?.activity.continuing;
  useEffect(() => {
    chatScope.current = Symbol();
    setEditors({});
    setPinned({});
    setChats({});
    setSelectedId(null);
    setChecked(new Map());
  }, [mailbox]);
  useEffect(
    () => () => {
      chatScope.current = Symbol();
    },
    [],
  );
  const nextInboxCursor = inboxQuery.data?.pages.at(-1)?.nextCursor;
  const {
    fetchNextPage: fetchInboxNext,
    isFetching: inboxFetching,
    isError: inboxError,
  } = inboxQuery;
  const requestedInboxCursor = useRef<string>();
  useEffect(() => {
    if (!nextInboxCursor) requestedInboxCursor.current = undefined;
    if (
      !mailboxAvailable ||
      !inboxMode ||
      !nextInboxCursor ||
      inboxFetching ||
      inboxError ||
      requestedInboxCursor.current === nextInboxCursor
    )
      return;
    requestedInboxCursor.current = nextInboxCursor;
    void fetchInboxNext().catch(() => undefined);
  }, [mailboxAvailable, inboxMode, nextInboxCursor, inboxFetching, inboxError, fetchInboxNext]);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setSelectedId(null);
      setChecked(new Map());
    }, 300);
    return () => clearTimeout(timer);
  }, [search, query]);
  const refreshResults = resultQuery.refetch;
  useEffect(() => {
    if (previousRunning.current && !running) void refreshResults();
    previousRunning.current = running;
  }, [running, refreshResults]);
  const moveProgress = jobs
    .map((job) => `${job.id}:${job.completed}:${job.failed}:${job.status}`)
    .join('|');
  const previousMoveProgress = useRef('');
  useEffect(() => {
    if (moveProgress && previousMoveProgress.current !== moveProgress) void refreshResults();
    previousMoveProgress.current = moveProgress;
  }, [moveProgress, refreshResults]);
  useEffect(() => {
    setChecked((previous) => {
      const next = new Map(previous);
      for (const row of rows) if (row.moveStatus) next.delete(row.id);
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);
  useEffect(() => {
    if (!searchReturnFocus.current || search !== query) return;
    searchReturnFocus.current = false;
    const first = rows[0];
    setSelectedId(first?.id || null);
    if (first) rowButtons.current.get(first.id)?.focus({ preventScroll: true });
    else workspace.current?.focus();
  }, [rows, search, query]);
  const finishSearch = () => {
    searchReturnFocus.current = true;
    setQuery(search);
    setSelectedId(null);
    setChecked(new Map());
  };
  const refreshMailbox = () => {
    if (resultQuery.isFetching) return;
    requestedInboxCursor.current = undefined;
    void actions.refresh();
    if (inboxMode) void inboxQuery.refresh();
  };
  return (
    <main
      ref={workspace}
      className="mail-workspace"
      tabIndex={0}
      aria-label={t('com_ui_mail_workspace')}
      onKeyDown={(event) => {
        if (
          !status?.available ||
          !status.connection.connected ||
          settingsOpen ||
          folderPicker ||
          shortcutsOpen
        )
          return;
        const target = event.target;
        if (
          isMailEscape(event) &&
          target instanceof HTMLElement &&
          target.closest(
            'input:not([type="checkbox"]), textarea, [contenteditable="true"], [data-mail-shortcuts="off"]',
          ) &&
          !target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') &&
          !document.querySelector(
            '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]',
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (target === searchInput.current && search !== query) finishSearch();
          else focusList();
          return;
        }
        const key = mailShortcutKey(event);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === '/') {
          searchInput.current?.focus();
          return;
        }
        if (key === '?') {
          setShortcutsOpen(true);
          return;
        }
        if (key === 'g') {
          refreshMailbox();
          return;
        }
        if (key === ',') {
          setSettingsOpen(true);
          return;
        }
        if (key === 'l') {
          focusList();
          return;
        }
        if (key === 'Escape') {
          const details = event.currentTarget.querySelector<HTMLDetailsElement>(
            '.mail-activity-details[open]',
          );
          if (details) {
            details.open = false;
            details.querySelector('summary')?.focus();
            return;
          }
          setChecked(new Map());
          setNotice('');
          return;
        }
        if (key === 'e' || key === 'Shift+e') {
          const items = checked.size ? Array.from(checked.values()) : [];
          if (!items.length && selected) items.push(selected);
          if (key === 'e' && folder) requestMove(items, folder);
          else if (
            items.length &&
            !moveUnavailable &&
            !items.some(
              (item) =>
                item.moveStatus || item.mailboxLocation === 'sent' || currentEditor(item.id),
            ) &&
            status.settings.consentVersion === consentVersion
          ) {
            setMoveFolderItems(items);
            setFolderPicker(true);
          }
          return;
        }
        if (key === 'Shift+x') {
          setChecked(allSelected ? new Map() : new Map(selectable.map((row) => [row.id, row])));
          return;
        }
        if (['r', 'c', 'o', 'm', 'd', 'a', 'h', 'p'].includes(key)) {
          if (!selected) return;
          const action = {
            r: 'reply',
            c: 'chat',
            o: 'outlook',
            m: 'original',
            d: 'draft',
            a: 'attachments',
            h: 'correspondence',
            p: 'research',
          } as const;
          detailControls.current?.[action[key as keyof typeof action]]();
          return;
        }
        if (['1', '2', '3'].includes(key)) {
          if (
            !selected ||
            editor ||
            selected.mailboxLocation === 'sent' ||
            actions.priority.isLoading ||
            status.settings.consentVersion !== consentVersion
          )
            return;
          actions.priority.mutate(
            {
              id: selected.id,
              priority: ({ '1': 'important', '2': 'normal', '3': 'low' } as const)[
                key as '1' | '2' | '3'
              ],
            },
            {
              onError: () => setNotice(t('com_ui_mail_error')),
            },
          );
          return;
        }
        if (key === 'x') {
          if (!selected || selected.moveStatus || selected.mailboxLocation === 'sent') return;
          setChecked((previous) => {
            const next = new Map(previous);
            if (next.has(selected.id)) next.delete(selected.id);
            else if (next.size < 100) next.set(selected.id, selected);
            return next;
          });
          return;
        }
        if (!rows.length) return;
        const index = rows.findIndex((row) => row.id === selectedId);
        const offset = key === 'j' || key === 'ArrowDown' ? 1 : -1;
        let nextIndex = index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + offset));
        if (key === 'Home') nextIndex = 0;
        if (key === 'End') nextIndex = rows.length - 1;
        const next = rows[nextIndex];
        openMail(next);
        const button = rowButtons.current.get(next.id);
        button?.focus({ preventScroll: true });
        button?.scrollIntoView?.({ block: 'nearest' });
      }}
    >
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
            onClick={() => setShortcutsOpen(true)}
            aria-label={t('com_ui_mail_shortcuts')}
            title={t('com_ui_mail_shortcuts')}
          >
            <Keyboard size={16} />
          </button>
          <button
            className="mail-button"
            onClick={refreshMailbox}
            disabled={resultQuery.isFetching}
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

      {status?.connection.connected && jobsQuery.isError && (
        <p className="mail-banner mail-error" role="alert">
          {t('com_ui_mail_job_loading_error')}
        </p>
      )}
      {status?.available && status.connection.connected && <MailResearchProgress />}
      <MoveProgress
        jobs={status?.connection.connected ? jobs : []}
        running={running}
        odooAvailable={status?.odooAvailable === true}
        details={
          <>
            {status?.activity.history.mode !== 'off' &&
              status?.activity.history.processed !== undefined && (
                <p>{t('com_ui_mail_processed', { count: status.activity.history.processed })}</p>
              )}
            {status?.activity.lastRunAt && (
              <p>
                {t('com_ui_mail_last_check', {
                  time: date(status.activity.lastRunAt, status.settings.timeZone),
                })}
              </p>
            )}
            {running && <p>{t('com_ui_mail_running')}</p>}
          </>
        }
      />
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
                ref={searchInput}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.altKey ||
                    event.shiftKey ||
                    event.repeat ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  finishSearch();
                }}
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
                setChecked(new Map());
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
                setChecked(new Map());
              }}
            >
              <option value="open">{t('com_ui_mail_open')}</option>
              <option value="done">{t('com_ui_mail_done')}</option>
              <option value="all">{t('com_ui_mail_all')}</option>
            </select>
            <span className="mail-count">{t('com_ui_mail_loaded', { count: rows.length })}</span>
            {inboxMode && (inboxQuery.isFetching || inboxQuery.hasNextPage) && (
              <span className="mail-muted" role="status">
                {t('com_ui_mail_inbox_loading', { count: loadedRows.length })}
              </span>
            )}
          </div>
          <div className="mail-bulk-selection">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!selectable.length}
                onChange={(event) =>
                  setChecked(
                    event.target.checked
                      ? new Map(selectable.map((row) => [row.id, row]))
                      : new Map(),
                  )
                }
              />
              {eligible.length > 100
                ? t('com_ui_mail_select_loaded_limit')
                : t('com_ui_mail_select_loaded', { count: selectable.length })}
            </label>
            <span>{t('com_ui_mail_selection_count', { count: checked.size })}</span>
            {checked.size > 0 && (
              <button className="mail-button" onClick={() => setChecked(new Map())}>
                {t('com_ui_mail_selection_clear')}
              </button>
            )}
            <button className="mail-button" onClick={() => setFolderPicker(true)}>
              {folder?.displayName || t('com_ui_mail_choose_folder')}
            </button>
            <button
              className="mail-button primary"
              disabled={
                !checked.size ||
                !folder ||
                moveUnavailable ||
                selectionHasEditor ||
                status.settings.consentVersion !== consentVersion
              }
              title={jobs.some(isMoveActive) ? t('com_ui_mail_move_active') : undefined}
              onClick={() => requestMove(Array.from(checked.values()))}
            >
              <FolderCheck size={15} />
              {t('com_ui_mail_move_selected')}
            </button>
            {rows.length > 100 && <p className="mail-muted">{t('com_ui_mail_selection_limit')}</p>}
            {selectionHasEditor && (
              <p className="mail-notice">{t('com_ui_mail_edit_before_move')}</p>
            )}
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
                  <li key={row.id} className="mail-selectable-row">
                    <label className="mail-row-check">
                      <input
                        type="checkbox"
                        aria-label={t('com_ui_mail_select_one', { subject: row.subject })}
                        checked={checked.has(row.id)}
                        tabIndex={row.id === tabRowId ? 0 : -1}
                        disabled={
                          !!row.moveStatus ||
                          row.mailboxLocation === 'sent' ||
                          (!checked.has(row.id) && checked.size >= 100)
                        }
                        onChange={(event) =>
                          setChecked((previous) => {
                            const next = new Map(previous);
                            if (event.target.checked) next.set(row.id, row);
                            else next.delete(row.id);
                            return next;
                          })
                        }
                      />
                    </label>
                    <button
                      ref={(element) => {
                        if (element) rowButtons.current.set(row.id, element);
                        else rowButtons.current.delete(row.id);
                      }}
                      className={`mail-row ${row.id === selectedId ? 'selected' : ''}`}
                      tabIndex={row.id === tabRowId ? 0 : -1}
                      onClick={() => openMail(row)}
                      aria-pressed={row.id === selectedId}
                    >
                      <div className="mail-row-top">
                        <span className="mail-row-sender">{row.sender}</span>
                        <ResponseAction value={row} timeZone={status.settings.timeZone} />
                        <time>{date(row.receivedAt, status.settings.timeZone)}</time>
                      </div>
                      <div className="mail-row-subject">
                        {row.subject || t('com_ui_mail_no_subject')}
                      </div>
                      <div className="mail-row-preview">
                        <p>{row.summary}</p>
                        <span className={`mail-priority ${row.priority}`}>
                          {t(
                            row.analysisStatus === 'pending'
                              ? 'com_ui_mail_not_analyzed'
                              : priorities[row.priority],
                          )}
                        </span>
                        {row.moveStatus === 'completed' ? (
                          <span title={t('com_ui_mail_done')} aria-label={t('com_ui_mail_done')}>
                            <Check size={12} />
                          </span>
                        ) : null}
                        {row.moveStatus !== 'completed' && row.draftStatus !== 'none' ? (
                          <span
                            title={t(draftStates[row.draftStatus])}
                            aria-label={t(draftStates[row.draftStatus])}
                          >
                            <FileText size={12} />
                          </span>
                        ) : null}
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
                    ref={detailControls}
                    key={selected.id}
                    result={selected}
                    status={status}
                    folder={folder}
                    onMove={requestMove}
                    moveUnavailable={moveUnavailable}
                    editor={editor}
                    chatState={chats[selected.id] || emptyMailChat()}
                    onChatChange={(update) => {
                      if (chatScope.current !== activeChatScope) return;
                      setChats((previous) =>
                        chatScope.current === activeChatScope
                          ? {
                              ...previous,
                              [selected.id]: update(previous[selected.id] || emptyMailChat()),
                            }
                          : previous,
                      );
                    }}
                    onOpen={openMail}
                    onEditorChange={(value) =>
                      setEditors((previous) => {
                        if (chatScope.current !== activeChatScope) return previous;
                        const next = { ...previous };
                        if (value) next[selected.id] = value;
                        else delete next[selected.id];
                        return next;
                      })
                    }
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
      {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
      {folderPicker && status?.connection.connected && (
        <div className="mail-move-overlay">
          <div className="mail-move-dialog">
            <FolderPicker
              active
              moveCount={moveFolderItems?.length}
              chosen={folder}
              onChoose={(chosen) => {
                if (moveFolderItems) {
                  if (!folder) chooseFolder(chosen);
                  requestMove(moveFolderItems, chosen);
                } else chooseFolder(chosen);
              }}
              onClose={() => {
                setFolderPicker(false);
                setMoveFolderItems(null);
              }}
            />
          </div>
        </div>
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
