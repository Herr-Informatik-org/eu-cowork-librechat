import { useState } from 'react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import { useMailActions } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';

export default function PersonalRule({
  result,
  disabled,
}: {
  result: MailWorkspaceResult;
  disabled: boolean;
}) {
  const t = useLocalize();
  const { rule } = useMailActions();
  const [scope, setScope] = useState<'message' | 'sender' | 'global'>('message');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <details className="mail-summary">
      <summary>{t('com_ui_mail_rule_title')}</summary>
      <p className="mail-muted">{t('com_ui_mail_rule_hint')}</p>
      <label className="mail-edit-label">
        {t('com_ui_mail_rule_scope')}
        <select
          value={scope}
          disabled={disabled || rule.isLoading}
          onChange={(event) => {
            setScope(event.target.value as typeof scope);
            setSaved(false);
          }}
        >
          <option value="message">{t('com_ui_mail_rule_message')}</option>
          <option value="sender">{t('com_ui_mail_rule_sender', { sender: result.sender })}</option>
          <option value="global">{t('com_ui_mail_rule_global')}</option>
        </select>
      </label>
      {scope === 'message' ? (
        <p>{t('com_ui_mail_rule_message_hint')}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            rule.mutate(
              { id: result.id, revision: result.revision, text: text.trim(), scope },
              {
                onSuccess: () => {
                  setSaved(true);
                  setText('');
                },
              },
            );
          }}
        >
          <label className="mail-edit-label">
            {t('com_ui_mail_rule_text')}
            <textarea
              rows={3}
              value={text}
              minLength={12}
              maxLength={2400}
              required
              disabled={disabled || rule.isLoading}
              placeholder={t('com_ui_mail_rule_example')}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <button
            className="mail-button"
            disabled={disabled || rule.isLoading || text.trim().length < 12}
          >
            {t('com_ui_mail_rule_save')}
          </button>
        </form>
      )}
      {saved && <p role="status">{t('com_ui_mail_rule_saved')}</p>}
      {rule.isError && (
        <p role="alert" className="mail-error">
          {t('com_ui_mail_rule_error')}
        </p>
      )}
    </details>
  );
}
