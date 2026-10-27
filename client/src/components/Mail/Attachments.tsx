import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import { useMailAttachments } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';

export function MailAttachments({ result }: { result: MailWorkspaceResult }) {
  return <Attachments key={`${result.id}:${result.revision}`} result={result} />;
}

function Attachments({ result }: { result: MailWorkspaceResult }) {
  const t = useLocalize();
  const [open, setOpen] = useState(false);
  const query = useMailAttachments(result.id, result.revision, open);
  return (
    <details
      className="mail-attachments"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-mail-shortcuts="off"
    >
      <summary>
        <Paperclip size={14} />
        {t('com_ui_mail_attachments')}
        {query.data && ` (${query.data.attachments.length}${query.data.hasMore ? '+' : ''})`}
      </summary>
      <p className="mail-muted">{t('com_ui_mail_attachments_scope')}</p>
      {open && query.isLoading && <p role="status">{t('com_ui_loading')}</p>}
      {query.isError && (
        <p role="alert" className="mail-error">
          {mailActionError(query.error, t('com_ui_mail_attachments_error'))}
        </p>
      )}
      {query.data && (
        <>
          {!query.data.attachments.length && <p>{t('com_ui_mail_attachments_none')}</p>}
          <ul className="mail-attachment-list">
            {query.data.attachments.map((item) => (
              <li key={item.id}>
                <span className="mail-attachment-name">
                  <bdi>{item.name}</bdi>
                </span>
                <span className="mail-muted">
                  <bdi>{item.contentType}</bdi>
                  {' · '}
                  {new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 }).format(
                    item.size / 1024,
                  )}{' '}
                  KB{item.isInline ? ` · ${t('com_ui_mail_attachments_inline')}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {query.data.hasMore && <p>{t('com_ui_mail_attachments_more')}</p>}
        </>
      )}
    </details>
  );
}
