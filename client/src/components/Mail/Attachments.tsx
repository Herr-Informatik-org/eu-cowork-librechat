import { useId, useState } from 'react';
import { Download, Loader2, Paperclip } from 'lucide-react';
import type {
  MailAttachments as AttachmentList,
  MailWorkspaceResult,
} from 'librechat-data-provider';
import { useMailAttachments } from '~/data-provider/Mail';
import {
  isDownloadableMailAttachment,
  useMailAttachmentDownload,
} from '~/data-provider/Mail/attachments';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';

export function MailAttachments({ result }: { result: MailWorkspaceResult }) {
  return <Attachments key={`${result.id}:${result.revision}`} result={result} />;
}

function AttachmentDownload({
  result,
  item,
  available,
}: {
  result: MailWorkspaceResult;
  item: AttachmentList['attachments'][number];
  available: boolean;
}) {
  const t = useLocalize();
  const statusId = useId();
  const action = useMailAttachmentDownload(result.id, result.revision, item);
  const supported = isDownloadableMailAttachment(item);
  const errorKeys = {
    422: 'com_ui_mail_attachment_blocked',
    503: 'com_ui_mail_attachment_scan_unavailable',
    429: 'com_ui_mail_attachment_scan_busy',
    413: 'com_ui_mail_attachment_unsupported',
    400: 'com_ui_mail_attachment_unsupported',
    409: 'com_ui_mail_attachment_changed',
  } as const;
  let message = t('com_ui_mail_attachment_download_scope');
  if (action.errorStatus !== undefined)
    message = t(
      errorKeys[action.errorStatus as keyof typeof errorKeys] ||
        'com_ui_mail_attachment_download_error',
    );
  else if (!available) message = t('com_ui_mail_attachment_scan_disabled');
  else if (!supported) message = t('com_ui_mail_attachment_unsupported');
  else if (action.scannedAt) message = t('com_ui_mail_attachment_downloaded');
  else if (action.isLoading) message = t('com_ui_mail_attachment_scanning_scope');
  return (
    <>
      <button
        type="button"
        className="mail-button"
        aria-disabled={action.isLoading || !available || !supported}
        aria-describedby={statusId}
        onClick={() => {
          if (available && supported && !action.isLoading) void action.download();
        }}
      >
        {action.isLoading ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Download size={14} aria-hidden="true" />
        )}
        {t(
          action.isLoading ? 'com_ui_mail_attachment_scanning' : 'com_ui_mail_attachment_download',
        )}
      </button>
      <span
        id={statusId}
        role="status"
        className={action.errorStatus !== undefined ? 'mail-error' : 'mail-muted'}
      >
        {message}
        {action.scannedAt && (
          <>
            {' '}
            <time dateTime={action.scannedAt}>
              {new Date(action.scannedAt).toLocaleString('de-CH')}
            </time>
          </>
        )}
      </span>
    </>
  );
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
                <AttachmentDownload
                  result={result}
                  item={item}
                  available={query.data.downloadAvailable === true}
                />
              </li>
            ))}
          </ul>
          {query.data.hasMore && <p>{t('com_ui_mail_attachments_more')}</p>}
        </>
      )}
    </details>
  );
}
