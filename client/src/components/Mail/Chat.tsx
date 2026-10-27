import { useEffect, useRef, useState } from 'react';
import { Copy, Loader2, MessageSquare, Search } from 'lucide-react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import { useMailChat, useMailCorrespondence } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: MailWorkspaceResult[];
};
export type MailChatState = {
  messages: Message[];
  input: string;
  includeCorrespondence: boolean;
  pending?: boolean;
  pendingQuestion?: string;
  error?: string;
};
export const emptyMailChat = (): MailChatState => ({
  messages: [],
  input: '',
  includeCorrespondence: false,
});

export function MailChat({
  result,
  draft,
  state,
  onChange,
  onOpen,
  onApply,
  focusRequest = 0,
}: {
  result: MailWorkspaceResult;
  draft?: string;
  state: MailChatState;
  onChange: (update: (previous: MailChatState) => MailChatState) => void;
  onOpen: (result: MailWorkspaceResult) => void;
  onApply?: (text: string) => void;
  focusRequest?: number;
}) {
  const t = useLocalize();
  const mutation = useMailChat(result.id);
  const input = useRef<HTMLTextAreaElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const confirm = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState('');
  const [replacement, setReplacement] = useState<string>();
  useEffect(() => {
    input.current?.focus();
  }, [focusRequest]);
  useEffect(() => {
    if (replacement === undefined) return;
    const previous = document.activeElement;
    confirm.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [replacement]);
  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.messages.length, state.pending]);
  const submit = async () => {
    const message = state.input.trim();
    if (!message || state.pending || submitting.current) return;
    submitting.current = true;
    const history = state.messages.slice(-12).map(({ role, content }) => ({ role, content }));
    onChange((previous) => ({
      ...previous,
      pending: true,
      pendingQuestion: message,
      error: undefined,
    }));
    try {
      const response = await mutation.mutateAsync({
        revision: result.revision,
        message,
        history,
        draft,
        includeCorrespondence: state.includeCorrespondence,
      });
      onChange((previous) => ({
        ...previous,
        pending: false,
        pendingQuestion: undefined,
        input: '',
        messages: [
          ...previous.messages,
          { role: 'user', content: message },
          { role: 'assistant', content: response.answer, sources: response.sources },
        ].slice(-40) as Message[],
      }));
    } catch (error) {
      onChange((previous) => ({
        ...previous,
        pending: false,
        pendingQuestion: undefined,
        error: mailActionError(error, t('com_ui_mail_chat_inline_error')),
      }));
    } finally {
      submitting.current = false;
    }
  };
  return (
    <section
      className="mail-inline-chat"
      aria-label={t('com_ui_mail_chat_inline_title')}
      data-mail-shortcuts="off"
    >
      <div className="mail-summary-heading">
        <h3>
          <MessageSquare size={15} /> {t('com_ui_mail_chat_inline_title')}
        </h3>
        {!!state.messages.length && (
          <button
            className="mail-button"
            disabled={state.pending}
            onClick={() => onChange(() => emptyMailChat())}
          >
            {t('com_ui_mail_chat_inline_clear')}
          </button>
        )}
      </div>
      <p className="mail-muted">{t('com_ui_mail_chat_inline_hint')}</p>
      <div ref={messageList} className="mail-chat-messages" aria-live="polite">
        {state.messages.map((message, index) => (
          <article key={index} className={`mail-chat-message ${message.role}`}>
            <h4>
              {t(
                message.role === 'user'
                  ? 'com_ui_mail_chat_inline_user'
                  : 'com_ui_mail_chat_inline_assistant',
              )}
            </h4>
            <p>{message.content}</p>
            {message.sources?.length ? (
              <details>
                <summary>{t('com_ui_mail_chat_inline_sources')}</summary>
                <ul>
                  {message.sources.map((source) => (
                    <li key={source.id}>
                      <button className="mail-link" onClick={() => onOpen(source)}>
                        {source.subject || t('com_ui_mail_no_subject')}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {message.role === 'assistant' && (
              <div className="mail-body-actions">
                <button
                  className="mail-button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(message.content)
                      .then(() => setNotice(t('com_ui_mail_copied')))
                      .catch(() => setNotice(t('com_ui_mail_copy_error')))
                  }
                >
                  <Copy size={13} />
                  {t('com_ui_mail_chat_inline_copy')}
                </button>
                <button
                  className="mail-button"
                  disabled={!onApply || message.content.length > 12000}
                  onClick={() => setReplacement(message.content)}
                >
                  {t('com_ui_mail_chat_inline_apply')}
                </button>
              </div>
            )}
          </article>
        ))}
        {state.pendingQuestion && (
          <article className="mail-chat-message user">
            <h4>{t('com_ui_mail_chat_inline_user')}</h4>
            <p>{state.pendingQuestion}</p>
          </article>
        )}
        {state.pending && (
          <p role="status">
            <Loader2 className="animate-spin" size={14} />
            {t('com_ui_mail_chat_inline_thinking')}
          </p>
        )}
      </div>
      {replacement !== undefined && (
        <section
          ref={confirm}
          className="mail-notice"
          role="alertdialog"
          aria-modal="true"
          aria-label={t('com_ui_mail_chat_inline_apply')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setReplacement(undefined);
            }
            if (event.key === 'Tab') {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
              );
              const first = buttons[0];
              const last = buttons.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <p>{t('com_ui_mail_chat_inline_replace_confirm')}</p>
          <div className="mail-body-actions">
            <button
              className="mail-button primary"
              onClick={() => {
                onApply?.(replacement);
                setReplacement(undefined);
              }}
            >
              {t('com_ui_mail_chat_inline_apply')}
            </button>
            <button className="mail-button" onClick={() => setReplacement(undefined)}>
              {t('com_ui_mail_cancel')}
            </button>
          </div>
        </section>
      )}
      {!onApply && state.messages.length > 0 && (
        <p className="mail-muted">{t('com_ui_mail_chat_inline_apply_hint')}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {state.error && (
        <p className="mail-error" role="alert">
          {state.error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          {t('com_ui_mail_chat_inline_question')}
          <textarea
            ref={input}
            rows={3}
            maxLength={4000}
            value={state.input}
            disabled={state.pending}
            placeholder={t('com_ui_mail_chat_inline_placeholder')}
            onChange={(event) => {
              const value = event.target.value;
              onChange((previous) => ({ ...previous, input: value }));
            }}
          />
        </label>
        <div className="mail-chat-submit">
          <label className="mail-check">
            <input
              type="checkbox"
              checked={state.includeCorrespondence}
              disabled={state.pending}
              onChange={(event) => {
                const checked = event.target.checked;
                onChange((previous) => ({ ...previous, includeCorrespondence: checked }));
              }}
            />
            {t('com_ui_mail_chat_inline_context')}
          </label>
          <button
            type="submit"
            className="mail-button primary"
            disabled={!state.input.trim() || state.pending}
          >
            {t('com_ui_mail_chat_inline_send')}
          </button>
        </div>
      </form>
    </section>
  );
}

export function MailCorrespondence({
  result,
  onOpen,
}: {
  result: MailWorkspaceResult;
  onOpen: (result: MailWorkspaceResult) => void;
}) {
  const t = useLocalize();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const matches = useMailCorrespondence(result.id, query, open);
  const rows = matches.data?.pages.flatMap((page) => page.results) || [];
  return (
    <details
      className="mail-correspondence"
      data-mail-shortcuts="off"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t('com_ui_mail_correspondence_title')}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <label className="mail-search">
          <Search size={14} />
          <input
            value={search}
            maxLength={200}
            aria-label={t('com_ui_mail_correspondence_search')}
            placeholder={t('com_ui_mail_correspondence_search')}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button className="mail-button" type="submit">
          {t('com_ui_mail_correspondence_search_button')}
        </button>
      </form>
      {matches.isLoading && open && <p role="status">{t('com_ui_mail_loading')}</p>}
      {matches.isError && (
        <p role="alert" className="mail-error">
          {t('com_ui_mail_correspondence_error')}
        </p>
      )}
      {!matches.isLoading && !matches.isError && !rows.length && (
        <p className="mail-muted">{t('com_ui_mail_correspondence_empty')}</p>
      )}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              onClick={() => onOpen(row)}
              aria-label={t('com_ui_mail_correspondence_open', { subject: row.subject })}
            >
              <strong>{row.subject || t('com_ui_mail_no_subject')}</strong>
              <span>{row.sender}</span>
              <time>{new Date(row.receivedAt).toLocaleString('de-CH')}</time>
            </button>
          </li>
        ))}
      </ul>
      {matches.hasNextPage && (
        <button
          className="mail-button"
          disabled={matches.isFetchingNextPage}
          onClick={() => void matches.fetchNextPage()}
        >
          {t(matches.isFetchingNextPage ? 'com_ui_mail_loading' : 'com_ui_mail_load_more')}
        </button>
      )}
    </details>
  );
}
