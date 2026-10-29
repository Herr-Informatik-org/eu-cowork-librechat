import { useEffect, useId, useRef, useState } from 'react';
import { FilePenLine, ExternalLink, Loader2 } from 'lucide-react';
import type { MailWorkspaceResult, MailWorkspaceContent } from 'librechat-data-provider';
import { useMailDraftRequest } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';
import { isMailEscape, isMailSubmitShortcut } from './Shortcuts';

export function safeOutlookDraftUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      ['https://outlook.office.com', 'https://outlook.office365.com'].includes(url.origin) &&
      !url.username &&
      !url.password &&
      (url.pathname.startsWith('/mail/') || url.pathname === '/owa/' || url.pathname === '/owa')
    )
      return url.href;
  } catch {
    return;
  }
}

type Props = {
  result: MailWorkspaceResult;
  content?: MailWorkspaceContent;
  editing?: boolean;
  disabled?: boolean;
  openRequest?: number;
  instructionRequest?: { id: number; text: string };
};

export function MailDraftRequest(props: Props) {
  return <DraftRequest key={props.result.id} {...props} />;
}

function DraftRequest({
  result,
  content,
  editing = false,
  disabled = false,
  openRequest = 0,
  instructionRequest,
}: Props) {
  const t = useLocalize();
  const mutation = useMailDraftRequest();
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [newReply, setNewReply] = useState(false);
  const [instructionsTruncated, setInstructionsTruncated] = useState(false);
  const instructionId = useRef<number>();
  const input = useRef<HTMLTextAreaElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const outlookLink = useRef<HTMLAnchorElement>(null);
  const resultStatus = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef(false);
  const submitting = useRef(false);
  const shortcutHint = useId();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const outcome = mutation.data;
  const url = safeOutlookDraftUrl(outcome?.draftUrl || content?.draft?.url);
  const existing =
    !!content?.draft || ['created', 'existing', 'stale', 'uncertain'].includes(result.draftStatus);
  const uncertain = result.draftStatus === 'uncertain' || outcome?.status === 'uncertain';
  const canRequestNew =
    !uncertain && !editing && !disabled && !mutation.isLoading && (!newReply || !outcome);
  const openNewReply = () => {
    if (!canRequestNew) return;
    mutation.reset?.();
    setRequestId(crypto.randomUUID());
    setNewReply(true);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    if (trigger.current && !trigger.current.disabled) trigger.current.focus();
    else container.current?.focus();
  };
  const submit = () => {
    if (
      disabled ||
      editing ||
      mutation.isLoading ||
      submitting.current ||
      (existing && !newReply) ||
      uncertain ||
      outcome ||
      !open
    )
      return;
    submitting.current = true;
    returnFocus.current = !!container.current?.contains(document.activeElement);
    mutation.mutate(
      {
        id: result.id,
        revision: result.revision,
        instructions,
        requestId,
        ...(newReply ? { newReply: true } : {}),
      },
      {
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };
  useEffect(() => {
    if (
      !instructionRequest ||
      instructionId.current === instructionRequest.id ||
      disabled ||
      editing ||
      uncertain ||
      mutation.isLoading
    )
      return;
    instructionId.current = instructionRequest.id;
    const combined = [instructions, instructionRequest.text].filter(Boolean).join('\n\n');
    setInstructionsTruncated(combined.length > 4000);
    setInstructions(combined.slice(0, 4000));
    if (existing || outcome) {
      mutation.reset?.();
      setRequestId(crypto.randomUUID());
      setNewReply(true);
    }
    setOpen(true);
  }, [instructionRequest, disabled, editing, uncertain, mutation, existing, outcome, instructions]);
  useEffect(() => {
    if (openRequest > 0 && !disabled && !editing && !existing) setOpen(true);
  }, [openRequest, disabled, editing, existing]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, openRequest]);
  useEffect(() => {
    if (!outcome || !returnFocus.current) return;
    returnFocus.current = false;
    if (
      document.activeElement === document.body ||
      container.current?.contains(document.activeElement)
    ) {
      (outlookLink.current || resultStatus.current)?.focus();
    }
  }, [outcome]);
  return (
    <div ref={container} tabIndex={-1} className="mail-draft-request" data-mail-shortcuts="off">
      <div className="mail-draft-controls">
        {!existing && !outcome && (
          <button
            ref={trigger}
            className="mail-button"
            disabled={disabled || editing || mutation.isLoading}
            onClick={() => setOpen((value) => !value)}
          >
            <FilePenLine size={14} />
            {t('com_ui_mail_draft_request')}
          </button>
        )}
        {(existing || result.responseAction === 'forwarded') && canRequestNew && (
          <button className="mail-button" onClick={openNewReply}>
            <FilePenLine size={14} aria-hidden="true" />
            {t('com_ui_mail_new_reply')}
          </button>
        )}
        {url && (
          <a
            ref={outlookLink}
            className="mail-button"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={14} />
            {t('com_ui_mail_draft_open_outlook')}
          </a>
        )}
      </div>
      {existing && !url && <p className="mail-muted">{t('com_ui_mail_draft_existing_outlook')}</p>}
      {open && !outcome && (!existing || newReply) && !uncertain && (
        <form
          className="mail-card"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (!isMailEscape(event)) return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          {newReply && <p className="mail-muted">{t('com_ui_mail_new_reply_scope')}</p>}
          {!!content?.message.replyRecipients?.length && (
            <p className="mail-draft-recipients">
              <strong>
                {t(
                  content.message.replyMode === 'all'
                    ? 'com_ui_mail_draft_reply_all_to'
                    : 'com_ui_mail_draft_reply_to',
                )}
              </strong>
              :{' '}
              {content.message.replyRecipients
                .map((recipient) =>
                  recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address,
                )
                .join(', ')}
            </p>
          )}
          {!!content?.message.replyCcRecipients?.length && (
            <p className="mail-draft-recipients">
              <strong>{t('com_ui_mail_draft_reply_cc')}</strong>:{' '}
              {content.message.replyCcRecipients
                .map((recipient) =>
                  recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address,
                )
                .join(', ')}
            </p>
          )}
          <label>
            {t('com_ui_mail_draft_instructions')}
            <textarea
              ref={input}
              rows={3}
              maxLength={4000}
              value={instructions}
              disabled={disabled || editing || mutation.isLoading}
              aria-describedby={shortcutHint}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onKeyDown={(event) => {
                if (!isMailSubmitShortcut(event)) return;
                event.preventDefault();
                event.stopPropagation();
                submit();
              }}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('com_ui_mail_draft_instructions_example')}
            />
          </label>
          {instructionsTruncated && (
            <p className="mail-notice">{t('com_ui_mail_research_instructions_truncated')}</p>
          )}
          <p className="mail-muted">{t('com_ui_mail_draft_request_scope')}</p>
          <p id={shortcutHint} className="mail-muted">
            {t('com_ui_mail_draft_submit_shortcut')}
          </p>
          <div className="mail-draft-controls">
            <button
              className="mail-button primary"
              disabled={disabled || mutation.isLoading || editing}
              type="submit"
            >
              {mutation.isLoading && <Loader2 size={14} className="animate-spin" />}
              {t('com_ui_mail_draft_generate')}
            </button>
            <button className="mail-button" type="button" onClick={close}>
              {t('com_ui_mail_close')}
            </button>
          </div>
        </form>
      )}
      {mutation.isLoading && <p role="status">{t('com_ui_mail_draft_generating')}</p>}
      {mutation.isError && (
        <p className="mail-error" role="alert">
          {mailActionError(mutation.error, t('com_ui_mail_draft_request_error'))}
        </p>
      )}
      {outcome && (
        <p ref={resultStatus} tabIndex={-1} role="status">
          {t(
            outcome.status === 'uncertain'
              ? 'com_ui_mail_draft_request_uncertain'
              : 'com_ui_mail_draft_request_done',
          )}
        </p>
      )}
    </div>
  );
}
