import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { mailPreviewLink } from 'librechat-data-provider';
import type { MailWorkspacePreview } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

const colors = /^(?:#[a-f0-9]{3,8}|[a-z]{1,24}|rgba?\([0-9.,% ]{1,48}\))$/i;
const unit = '(?:0|[0-9]{1,2}(?:\\.[0-9]{1,2})?(?:px|pt)|[0-4](?:\\.[0-9]{1,2})?em)';
const spacing = new RegExp(`^${unit}(?: ${unit}){0,3}$`);
const dimension = /^(?:auto|0|[0-9]{1,4}(?:px|pt)|(?:[0-9]{1,2}|100)%)$/;
const styles: Record<string, RegExp> = {
  color: colors,
  'background-color': colors,
  'font-family': /^[a-z0-9 ,"'_-]{1,160}$/i,
  'font-size':
    /^(?:[0-9]{1,2}(?:\.[0-9]{1,2})?(?:px|pt)|[0-4](?:\.[0-9]{1,2})?em|(?:[0-9]{1,2}|[12][0-9]{2})%|small|medium|large|x-small|x-large)$/,
  'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/,
  'font-style': /^(?:normal|italic|oblique)$/,
  'text-decoration':
    /^(?:none|underline|line-through|overline)(?: (?:underline|line-through|overline)){0,2}$/,
  'text-align': /^(?:left|right|center|justify|start|end)$/,
  'vertical-align': /^(?:top|middle|bottom|baseline|sub|super|text-top|text-bottom)$/,
  'line-height':
    /^(?:normal|[0-4](?:\.[0-9]{1,2})?|[0-9]{1,2}(?:px|pt)|(?:[0-9]{1,2}|[12][0-9]{2})%)$/,
  'white-space': /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/,
  'word-break': /^(?:normal|break-all|keep-all|break-word)$/,
  'overflow-wrap': /^(?:normal|break-word|anywhere)$/,
  'border-collapse': /^(?:collapse|separate)$/,
  'table-layout': /^(?:auto|fixed)$/,
  'border-color': colors,
  'border-style': /^(?:none|solid|dashed|dotted|double)$/,
  'border-width': /^[0-5](?:px|pt)$/,
  border: /^[0-5](?:px|pt) (?:solid|dashed|dotted|double) (?:#[a-f0-9]{3,8}|[a-z]{1,24})$/i,
  width: dimension,
  height: dimension,
  'max-width': dimension,
};
for (const prefix of ['margin', 'padding']) {
  styles[prefix] = spacing;
  for (const side of ['top', 'right', 'bottom', 'left']) styles[`${prefix}-${side}`] = spacing;
}

const allowedTags = [
  'p',
  'div',
  'span',
  'br',
  'hr',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'img',
];
const png = /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/;
const policy =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Server output remains untrusted: parse again before placing it in an opaque-origin frame. */
export function createMailPreviewDocument(html: string, linksEnabled = false): string | undefined {
  if (typeof html !== 'string' || html.length > 4_000_000) return;
  // Reject excessive markup before DOMPurify allocates its inert DOM; this is a size guard only.
  let marker = -1;
  let markers = 0;
  while ((marker = html.indexOf('<', marker + 1)) >= 0) {
    if (++markers > 40_000) return;
  }
  const sanitizer = DOMPurify();
  let count = 0;
  let images = 0;
  let imageBytes = 0;
  sanitizer.addHook('afterSanitizeAttributes', (node) => {
    if (++count > 20_000) throw new Error('Preview size limit');
    if (!(node instanceof Element)) return;
    const style = node.getAttribute('style');
    if (style) {
      const retained: string[] = [];
      // eslint-disable-next-line no-control-regex -- Reject CSS escapes and control bytes before parsing.
      if (style.length <= 2048 && !/[\\\u0000-\u001f@{}]/.test(style)) {
        const declaration = document.createElement('span').style;
        declaration.cssText = style;
        for (let index = 0; index < declaration.length; index++) {
          const name = declaration.item(index);
          const value = declaration.getPropertyValue(name).trim();
          if (styles[name]?.test(value)) retained.push(`${name}:${value}`);
        }
      }
      if (retained.length) node.setAttribute('style', retained.join(';'));
      else node.removeAttribute('style');
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name;
      const value = attribute.value;
      if (name === 'dir' && !/^(?:ltr|rtl|auto)$/.test(value)) node.removeAttribute(name);
      if (['width', 'height'].includes(name) && !/^(?:[0-9]{1,4}|(?:[0-9]{1,2}|100)%)$/.test(value))
        node.removeAttribute(name);
      if (
        ['colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'span'].includes(name) &&
        !/^[0-9]{1,2}$/.test(value)
      )
        node.removeAttribute(name);
      if (
        ['align', 'valign'].includes(name) &&
        !/^(?:left|right|center|justify|top|middle|bottom|baseline)$/.test(value)
      )
        node.removeAttribute(name);
    }
    if (node.tagName === 'A') {
      const link = linksEnabled === true && mailPreviewLink(node.getAttribute('href') || '');
      if (!link) {
        node.removeAttribute('href');
        return;
      }
      node.setAttribute('href', link.href);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.setAttribute(
        'title',
        link.viaSafeLinks ? 'erp.rzcloud.ch (Microsoft Safe Links)' : 'erp.rzcloud.ch',
      );
    }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') || '';
      if (
        source.length > 1_400_000 ||
        imageBytes + source.length > 3_000_000 ||
        images >= 8 ||
        !png.test(source)
      ) {
        node.removeAttribute('src');
        node.setAttribute('alt', '[Bild nicht geladen]');
      } else {
        imageBytes += source.length;
        images++;
      }
    }
  });
  let body: string;
  try {
    body = sanitizer.sanitize(html, {
      ALLOWED_TAGS: linksEnabled === true ? [...allowedTags, 'a'] : allowedTags,
      ALLOWED_ATTR: [
        ...(linksEnabled === true ? ['href'] : []),
        'style',
        'dir',
        'src',
        'alt',
        'width',
        'height',
        'colspan',
        'rowspan',
        'cellpadding',
        'cellspacing',
        'border',
        'span',
        'align',
        'valign',
      ],
      ALLOWED_URI_REGEXP:
        linksEnabled === true ? /^(?:https:\/\/|data:image\/png;base64,iVBORw0KGgo)/i : png,
      ADD_URI_SAFE_ATTR: [
        'style',
        'dir',
        'alt',
        'width',
        'height',
        'colspan',
        'rowspan',
        'cellpadding',
        'cellspacing',
        'border',
        'span',
        'align',
        'valign',
      ],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      KEEP_CONTENT: true,
      FORBID_TAGS: [
        'svg',
        'math',
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'template',
        'form',
      ],
      FORBID_CONTENTS: ['svg', 'math', 'script', 'style', 'iframe', 'object', 'embed', 'template'],
    });
  } catch {
    return;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}body{margin:16px;color:#17202a;font:14px Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin-left:12px;padding-left:12px;border-left:2px solid #d5dce3}</style></head><body>${body}</body></html>`;
}

export default function SafeMailPreview({
  preview,
  text,
  title,
}: {
  preview?: MailWorkspacePreview;
  text: string;
  title: string;
}) {
  const t = useLocalize();
  const linksEnabled = preview?.linksEnabled === true;
  const document = useMemo(
    () => preview && createMailPreviewDocument(preview.html, linksEnabled),
    [preview, linksEnabled],
  );
  return (
    <div>
      {document ? (
        <>
          <p className="mail-muted">
            {t(linksEnabled ? 'com_ui_mail_preview_erp_links' : 'com_ui_mail_preview_safety')}
          </p>
          {preview && preview.blockedImages > 0 && (
            <p className="mail-muted">
              {t('com_ui_mail_preview_blocked', { count: preview.blockedImages })}
            </p>
          )}
          {preview?.truncated && <p className="mail-muted">{t('com_ui_mail_preview_truncated')}</p>}
          {preview?.warnings.slice(0, 8).map((warning, index) => (
            <p className="mail-muted" key={index}>
              {warning}
            </p>
          ))}
          <iframe
            title={title}
            srcDoc={document}
            sandbox={linksEnabled ? 'allow-popups allow-popups-to-escape-sandbox' : ''}
            referrerPolicy="no-referrer"
            style={{
              display: 'block',
              width: '100%',
              height: '65vh',
              minHeight: '360px',
              border: 0,
              background: '#fff',
            }}
          />
        </>
      ) : (
        <>
          {preview && <p className="mail-muted">{t('com_ui_mail_preview_unavailable')}</p>}
          <pre>{text}</pre>
        </>
      )}
    </div>
  );
}
