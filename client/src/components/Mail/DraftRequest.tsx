import { useEffect, useRef, useState } from 'react';
import { FilePenLine, ExternalLink, Loader2 } from 'lucide-react';
import type { MailWorkspaceResult, MailWorkspaceContent } from 'librechat-data-provider';
import { useMailDraftRequest } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';

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
  openRequest?: number;
};

export function MailDraftRequest(props: Props) {
  return <DraftRequest key={props.result.id} {...props} />;
}

function DraftRequest({ result, content, editing = false, openRequest = 0 }: Props) {
  const t = useLocalize();
  const mutation = useMailDraftRequest();
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const outcome = mutation.data;
  const url = safeOutlookDraftUrl(outcome?.draftUrl || content?.draft?.url);
  const existing =
    !!content?.draft || ['created', 'existing', 'stale', 'uncertain'].includes(result.draftStatus);
  useEffect(() => {
    if (openRequest > 0 && !editing && !existing) setOpen(true);
  }, [openRequest, editing, existing]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, openRequest]);
  return (
    <div className="mail-draft-request" data-mail-shortcuts="off">
      <div className="mail-draft-controls">
        {!existing && !outcome && (
          <button
            className="mail-button"
            disabled={editing || mutation.isLoading}
            onClick={() => setOpen((value) => !value)}
          >
            <FilePenLine size={14} />
            {t('com_ui_mail_draft_request')}
          </button>
        )}
        {url && (
          <a className="mail-button" href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />
            {t('com_ui_mail_draft_open_outlook')}
          </a>
        )}
      </div>
      {existing && !url && <p className="mail-muted">{t('com_ui_mail_draft_existing_outlook')}</p>}
      {open && !outcome && !existing && (
        <form
          className="mail-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing || mutation.isLoading) return;
            mutation.mutate({ id: result.id, revision: result.revision, instructions, requestId });
          }}
        >
          {!!content?.message.replyRecipients?.length && (
            <p className="mail-draft-recipients">
              <strong>{t('com_ui_mail_draft_reply_to')}</strong>:{' '}
              {content.message.replyRecipients
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
              disabled={mutation.isLoading}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t('com_ui_mail_draft_instructions_example')}
            />
          </label>
          <p className="mail-muted">{t('com_ui_mail_draft_request_scope')}</p>
          <div className="mail-draft-controls">
            <button
              className="mail-button primary"
              disabled={mutation.isLoading || editing}
              type="submit"
            >
              {mutation.isLoading && <Loader2 size={14} className="animate-spin" />}
              {t('com_ui_mail_draft_generate')}
            </button>
            <button className="mail-button" type="button" onClick={() => setOpen(false)}>
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
        <p role="status">
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
