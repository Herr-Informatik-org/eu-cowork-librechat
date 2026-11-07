import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';

const shortcuts: { keys: string; label: TranslationKeys }[] = [
  { keys: 'J / ↓', label: 'com_ui_mail_shortcut_next' },
  { keys: 'K / ↑', label: 'com_ui_mail_shortcut_previous' },
  { keys: 'Home / End', label: 'com_ui_mail_shortcut_edges' },
  { keys: 'X', label: 'com_ui_mail_shortcut_select' },
  { keys: 'Shift + X', label: 'com_ui_mail_shortcut_select_all' },
  { keys: 'E', label: 'com_ui_mail_shortcut_move' },
  { keys: 'Shift + E', label: 'com_ui_mail_shortcut_move_other' },
  { keys: 'R', label: 'com_ui_mail_shortcut_reply' },
  { keys: 'C', label: 'com_ui_mail_shortcut_chat' },
  { keys: 'P', label: 'com_ui_mail_research_open' },
  { keys: 'O', label: 'com_ui_mail_shortcut_outlook' },
  { keys: 'M / D', label: 'com_ui_mail_shortcut_tabs' },
  { keys: 'A / H', label: 'com_ui_mail_shortcut_context' },
  { keys: 'L', label: 'com_ui_mail_shortcut_list' },
  { keys: 'G', label: 'com_ui_mail_shortcut_refresh' },
  { keys: ',', label: 'com_ui_mail_settings' },
  { keys: '1 / 2 / 3', label: 'com_ui_mail_shortcut_priority' },
  { keys: '/', label: 'com_ui_mail_shortcut_search' },
  { keys: '?', label: 'com_ui_mail_shortcuts' },
  { keys: 'Esc', label: 'com_ui_mail_shortcut_escape' },
  { keys: 'Ctrl / Cmd + Enter', label: 'com_ui_mail_shortcut_submit' },
  { keys: 'Tab / Shift + Tab', label: 'com_ui_mail_shortcut_tab' },
];

export function isMailSubmitShortcut(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

export function isMailEscape(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.key === 'Escape' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

export function trapMailDialogFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"], [contenteditable="true"], summary',
    ),
  ).filter((element) => !element.closest('[hidden], details:not([open]) > :not(summary)'));
  const first = controls.at(0);
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function mailShortcutKey(event: KeyboardEvent<HTMLElement>): string | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.shiftKey && !['?', 'e', 'x'].includes(event.key.toLowerCase()))
  )
    return null;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return null;
  if (
    target.closest(
      'input, textarea, select, iframe, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"], [data-mail-shortcuts="off"]',
    ) ||
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"]',
    ) ||
    document.activeElement?.tagName === 'IFRAME'
  )
    return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.shiftKey && (key === 'e' || key === 'x')) return `Shift+${key}`;
  return [
    'j',
    'k',
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
    'x',
    'e',
    'r',
    'c',
    'p',
    'o',
    'm',
    'd',
    'a',
    'h',
    'l',
    'g',
    ',',
    '1',
    '2',
    '3',
    '/',
    '?',
    'Escape',
  ].includes(key)
    ? key
    : null;
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const t = useLocalize();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="mail-move-overlay">
      <section
        className="mail-move-dialog mail-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-shortcuts-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            close.current?.focus();
          }
        }}
      >
        <div className="mail-settings-heading">
          <h2 id="mail-shortcuts-title">{t('com_ui_mail_shortcuts')}</h2>
          <button ref={close} className="mail-button" onClick={onClose}>
            {t('com_ui_mail_close')}
          </button>
        </div>
        <dl>
          {shortcuts.map(({ keys, label }) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <p className="mail-muted">{t('com_ui_mail_shortcut_scope')}</p>
      </section>
    </div>
  );
}
