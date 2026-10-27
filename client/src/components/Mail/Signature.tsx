import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { MailSignature } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

const empty: MailSignature = { enabled: false, html: '', fontFamily: 'Calibri', fontSize: 11 };
const clean = (html: string) =>
  DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'div',
      'span',
      'br',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'a',
      'table',
      'tbody',
      'tr',
      'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });

async function prepareLogo(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2_000_000) throw new Error();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let width = 0,
    height = 0;
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 255) throw new Error();
      const kind = bytes[offset + 1],
        size = view.getUint16(offset + 2);
      if (size < 2 || offset + size + 2 > bytes.length) throw new Error();
      if ([192, 193, 194].includes(kind)) {
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        break;
      }
      offset += size + 2;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000)
    throw new Error();
  const scale = Math.min(1, 320 / width, 160 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(file, {
    resizeWidth: canvas.width,
    resizeHeight: canvas.height,
  });
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error();
    for (let attempt = 0; attempt < 5; attempt++) {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const contentBytes = canvas.toDataURL('image/png').split(',')[1];
      if (contentBytes && contentBytes.length <= 32768) return contentBytes;
      canvas.width = Math.max(1, Math.floor(canvas.width * 0.75));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.75));
    }
    throw new Error();
  } finally {
    bitmap.close();
  }
}

/** Only the user's explicit input is used; mailbox messages are never signature sources. */
export function MailSignatureSettings({
  value,
  onChange,
  disabled = false,
}: {
  value?: MailSignature;
  onChange: (signature: MailSignature) => void;
  disabled?: boolean;
}) {
  const t = useLocalize();
  const signature = value ?? empty;
  const editor = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [tooLong, setTooLong] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const current = useRef(signature);
  current.current = signature;
  useEffect(() => {
    if (editor.current && signature.html !== last.current) {
      editor.current.innerHTML = clean(signature.html);
      last.current = signature.html;
    }
  }, [signature.html]);
  const publish = () => {
    if (!editor.current) return;
    const html = clean(editor.current.innerHTML);
    if (html.length > 20000) {
      setTooLong(true);
      editor.current.innerHTML = clean(signature.html);
      return;
    }
    setTooLong(false);
    last.current = html;
    onChange({ ...signature, html });
  };
  return (
    <fieldset className="mail-signature-settings" disabled={disabled} data-mail-shortcuts="off">
      <legend>{t('com_ui_mail_signature_title')}</legend>
      <label>
        <input
          type="checkbox"
          checked={signature.enabled}
          onChange={(event) => onChange({ ...signature, enabled: event.target.checked })}
        />
        {t('com_ui_mail_signature_enabled')}
      </label>
      <p className="mail-muted">{t('com_ui_mail_signature_scope')}</p>
      <div className="mail-draft-controls">
        <label>
          {t('com_ui_mail_signature_font')}
          <select
            value={signature.fontFamily}
            onChange={(event) =>
              onChange({
                ...signature,
                fontFamily: event.target.value as MailSignature['fontFamily'],
              })
            }
          >
            {['Aptos', 'Calibri', 'Arial'].map((font) => (
              <option key={font}>{font}</option>
            ))}
          </select>
        </label>
        <label>
          {t('com_ui_mail_signature_size')}
          <select
            value={signature.fontSize}
            onChange={(event) =>
              onChange({
                ...signature,
                fontSize: Number(event.target.value) as MailSignature['fontSize'],
              })
            }
          >
            {[10, 11, 12, 14].map((size) => (
              <option key={size} value={size}>
                {t('com_ui_mail_signature_size_value', { size })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id="mail-signature-help" className="mail-muted">
        {t('com_ui_mail_signature_paste')}
      </p>
      <div
        ref={editor}
        className="mail-signature-editor"
        role="textbox"
        aria-multiline="true"
        aria-label={t('com_ui_mail_signature_text')}
        aria-describedby="mail-signature-help"
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        style={{
          minHeight: 110,
          padding: 12,
          border: '1px solid var(--border-medium)',
          borderRadius: 8,
          background: '#fff',
          color: '#000',
          fontFamily: `${signature.fontFamily},Arial,sans-serif`,
          fontSize: `${signature.fontSize}pt`,
          lineHeight: 1.35,
        }}
        onInput={publish}
        onDrop={(event) => event.preventDefault()}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        }}
        onPaste={(event) => {
          event.preventDefault();
          if (disabled) return;
          const html = event.clipboardData.getData('text/html');
          const raw = html || event.clipboardData.getData('text/plain');
          if (raw.length > 20000) {
            setTooLong(true);
            return;
          }
          const selection = window.getSelection();
          if (!selection?.rangeCount || !editor.current?.contains(selection.anchorNode)) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const fragment = document.createDocumentFragment();
          if (html) {
            const template = document.createElement('template');
            template.innerHTML = clean(html);
            fragment.append(template.content);
          } else {
            raw.split(/\r?\n/).forEach((line, index) => {
              if (index) fragment.append(document.createElement('br'));
              fragment.append(document.createTextNode(line));
            });
          }
          const end = fragment.lastChild;
          range.insertNode(fragment);
          if (end) {
            range.setStartAfter(end);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }
          publish();
        }}
      />
      {tooLong && (
        <p role="alert" className="mail-error">
          {t('com_ui_mail_signature_too_long')}
        </p>
      )}
      <label>
        {t('com_ui_mail_signature_logo')}
        <input
          type="file"
          accept="image/png,image/jpeg"
          disabled={disabled || logoBusy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || disabled || logoBusy) return;
            setLogoBusy(true);
            setLogoError(false);
            try {
              const contentBytes = await prepareLogo(file);
              onChange({ ...current.current, logo: { contentBytes } });
            } catch {
              setLogoError(true);
            } finally {
              setLogoBusy(false);
            }
          }}
        />
      </label>
      <p className="mail-muted">{t('com_ui_mail_signature_logo_scope')}</p>
      {signature.logo && (
        <div>
          <img
            src={`data:image/png;base64,${signature.logo.contentBytes}`}
            alt={t('com_ui_mail_signature_logo')}
            style={{ maxWidth: 320, maxHeight: 160 }}
          />
          <button
            type="button"
            className="mail-button"
            disabled={disabled || logoBusy}
            onClick={() => {
              const { logo: _logo, ...withoutLogo } = signature;
              onChange(withoutLogo);
            }}
          >
            {t('com_ui_mail_signature_logo_remove')}
          </button>
        </div>
      )}
      {logoBusy && <p role="status">{t('com_ui_loading')}</p>}
      {logoError && (
        <p role="alert" className="mail-error">
          {t('com_ui_mail_signature_logo_error')}
        </p>
      )}
    </fieldset>
  );
}
