import { useRef, useState } from 'react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import { useMailActions } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import { isMailEscape, isMailSubmitShortcut } from './Shortcuts';

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
  const submitting = useRef(false);
  const details = useRef<HTMLDetailsElement>(null);
  const valid =
    !disabled &&
    !rule.isLoading &&
    scope !== 'message' &&
    text.trim().length >= 12 &&
    text.trim().length <= 2400;
  const save = () => {
    if (scope === 'message' || !valid || submitting.current) return;
    submitting.current = true;
    rule.mutate(
      { id: result.id, revision: result.revision, text: text.trim(), scope },
      {
        onSuccess: () => {
          setSaved(true);
          setText('');
        },
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };
  return (
    <details
      ref={details}
      className="mail-summary"
      data-mail-shortcuts="off"
      onKeyDown={(event) => {
        if (!isMailEscape(event) || !details.current) return;
        event.preventDefault();
        event.stopPropagation();
        details.current.open = false;
        details.current.querySelector('summary')?.focus();
      }}
    >
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
            save();
          }}
          onKeyDown={(event) => {
            if (!isMailSubmitShortcut(event)) return;
            event.preventDefault();
            event.stopPropagation();
            save();
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
              aria-keyshortcuts="Control+Enter Meta+Enter"
              disabled={disabled || rule.isLoading}
              placeholder={t('com_ui_mail_rule_example')}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="mail-muted">{t('com_ui_mail_rule_shortcut')}</p>
          <button className="mail-button" type="submit" disabled={!valid}>
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
