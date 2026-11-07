import type { MailWorkspaceContent } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Message = MailWorkspaceContent['message'];
type Recipient = NonNullable<Message['toRecipients']>[number];

function RecipientLabel({ value }: { value: Recipient }) {
  return (
    <bdi>
      {value.name && value.name !== value.address
        ? `${value.name} <${value.address}>`
        : value.address}
    </bdi>
  );
}

function RecipientList({ recipients, loading }: { recipients?: Recipient[]; loading: boolean }) {
  const t = useLocalize();
  if (!recipients)
    return (
      <span className="mail-muted">
        {t(loading ? 'com_ui_mail_header_loading' : 'com_ui_mail_header_unavailable')}
      </span>
    );
  if (!recipients.length) return <span className="mail-muted">{t('com_ui_mail_header_none')}</span>;
  const first = recipients.slice(0, 2).map((recipient, index) => (
    <span key={index}>
      {index > 0 && '; '}
      <RecipientLabel value={recipient} />
    </span>
  ));
  if (recipients.length <= 2) return <>{first}</>;
  return (
    <details>
      <summary>
        {first}
        {' · '}
        {t('com_ui_mail_header_more', { count: recipients.length - 2 })}
      </summary>
      <ul>
        {recipients.slice(2).map((recipient, index) => (
          <li key={index}>
            <RecipientLabel value={recipient} />
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function MailRecipients({
  message,
  sender,
  loading,
}: {
  message?: Message;
  sender: string;
  loading: boolean;
}) {
  const t = useLocalize();
  return (
    <dl className="mail-recipients" aria-label={t('com_ui_mail_header_original')}>
      <dt>{t('com_ui_mail_header_from')}</dt>
      <dd>
        <RecipientLabel
          value={{ name: message?.senderName || '', address: message?.sender || sender }}
        />
      </dd>
      <dt>{t('com_ui_mail_header_to')}</dt>
      <dd>
        <RecipientList recipients={message?.toRecipients} loading={loading} />
      </dd>
      <dt>{t('com_ui_mail_header_cc')}</dt>
      <dd>
        <RecipientList recipients={message?.ccRecipients} loading={loading} />
      </dd>
    </dl>
  );
}
