import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import DOMPurify from 'dompurify';
import { mailPreviewLink } from 'librechat-data-provider';
import type { MailPreviewLink, MailWorkspacePreview } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import {
  MAIL_PREVIEW_BRIDGE_SCRIPT,
  MAIL_PREVIEW_BRIDGE_HASH,
  useMailPreviewNavigation,
  MailPreviewLinkDialog,
} from './PreviewNavigation';

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
export function createMailPreviewDocument(
  html: string,
  linksEnabled = false,
  imagesEnabled = false,
  trustedOrigins?: readonly string[],
  navigation?: { token: string; links: MailPreviewLink[] },
): string | undefined {
  if (navigation && !/^[0-9]+(?:-[0-9]+){3}$/.test(navigation.token)) return;
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
      const link =
        linksEnabled === true && mailPreviewLink(node.getAttribute('href') || '', trustedOrigins);
      if (!link) {
        node.removeAttribute('href');
        return;
      }
      if (navigation) {
        node.setAttribute('data-mail-link-index', String(navigation.links.length));
        navigation.links.push(link);
      }
      node.setAttribute('href', link.href);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('referrerpolicy', 'no-referrer');
      node.setAttribute(
        'title',
        `${new URL(link.destination).hostname}${link.viaSafeLinks ? ' (Microsoft Safe Links)' : ''}`,
      );
    }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') || '';
      if (
        imagesEnabled !== true ||
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
  const interactive = navigation && navigation.links.length > 0;
  const framePolicy = interactive
    ? policy.replace("script-src 'none'", `script-src '${MAIL_PREVIEW_BRIDGE_HASH}'`)
    : policy;
  const frameToken = interactive ? ` data-mail-preview-token="${navigation.token}"` : '';
  const bridge = interactive ? `<script>${MAIL_PREVIEW_BRIDGE_SCRIPT}</script>` : '';
  return `<!doctype html><html${frameToken}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${framePolicy}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}body{margin:16px;color:#17202a;font:14px Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin-left:12px;padding-left:12px;border-left:2px solid #d5dce3}</style></head><body>${body}${bridge}</body></html>`;
}

export default function SafeMailPreview({
  preview,
  text,
  title,
  actions,
}: {
  preview?: MailWorkspacePreview;
  text: string;
  title: string;
  actions?: ReactNode;
}) {
  const t = useLocalize();
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  const check = preview?.linkCheck;
  const checkLabels = {
    not_listed: 'com_ui_mail_links_not_listed',
    known_threat: 'com_ui_mail_links_blocked',
    disabled: 'com_ui_mail_links_disabled',
    unavailable: 'com_ui_mail_links_unavailable',
  } as const;
  const checkLabel = check
    ? checkLabels[check.status] || 'com_ui_mail_links_unavailable'
    : 'com_ui_mail_links_unchecked';
  const linksEnabled =
    preview?.linksEnabled === true &&
    (!check || check.status === 'not_listed' || check.status === 'known_threat');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const trustedOrigins = preview?.trustedOrigins ?? (check ? [] : undefined);
  const frame = useMemo(() => {
    const token = crypto.getRandomValues(new Uint32Array(4)).join('-');
    const links: MailPreviewLink[] = [];
    const document =
      preview &&
      createMailPreviewDocument(
        preview.html,
        linksEnabled,
        preview.imagesLoaded === true,
        preview.trustedOrigins ?? (check ? [] : undefined),
        { token, links },
      );
    return { token, links: document ? links : [], document };
  }, [preview, linksEnabled, check]);
  const navigation = useMailPreviewNavigation({
    frameRef,
    documentToken: frame.token,
    links: frame.links,
    enabled: linksEnabled,
    trustedOrigins,
  });
  return (
    <div>
      <div className="mail-body-actions">
        {actions}
        {preview && (
          <button
            type="button"
            className="mail-button"
            aria-expanded={infoOpen}
            aria-controls={infoId}
            onClick={() => setInfoOpen((open) => !open)}
          >
            {check?.status === 'known_threat' ? (
              <AlertTriangle size={15} aria-hidden="true" />
            ) : (
              <Info size={15} aria-hidden="true" />
            )}
            {t('com_ui_mail_preview_info')}
          </button>
        )}
      </div>
      <MailPreviewLinkDialog navigation={navigation} />
      {infoOpen && preview && (
        <section
          className="mail-preview-info"
          id={infoId}
          aria-label={t('com_ui_mail_preview_info')}
        >
          <p className="mail-muted">
            {t(linksEnabled ? 'com_ui_mail_preview_allowed_links' : 'com_ui_mail_preview_safety')}
          </p>
          <p
            className={check?.status === 'known_threat' ? 'mail-error' : 'mail-muted'}
            role="status"
          >
            {t(checkLabel, { count: check?.blocked || 0 })}
            {check?.checkedAt && Number.isFinite(Date.parse(check.checkedAt)) && (
              <>
                {' '}
                {t('com_ui_mail_links_checked_at')}{' '}
                <time dateTime={check.checkedAt}>
                  {new Date(check.checkedAt).toLocaleString('de-CH')}
                </time>
              </>
            )}
            {check?.sourceUpdatedAt && Number.isFinite(Date.parse(check.sourceUpdatedAt)) && (
              <>
                {' '}
                {t('com_ui_mail_links_source_updated')}{' '}
                <time dateTime={check.sourceUpdatedAt}>
                  {new Date(check.sourceUpdatedAt).toLocaleString('de-CH')}
                </time>
              </>
            )}
          </p>
          {preview?.embeddedImagesAvailable && (
            <p className="mail-muted">{t('com_ui_mail_images_scope')}</p>
          )}
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
        </section>
      )}
      {frame.document ? (
        <>
          <iframe
            title={title}
            ref={frameRef}
            srcDoc={frame.document}
            sandbox={frame.links.length ? 'allow-scripts' : ''}
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
