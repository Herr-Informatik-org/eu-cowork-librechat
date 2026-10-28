import sanitizeHtml from 'sanitize-html';
import { mailPreviewLink } from 'librechat-data-provider';
import type { MailHtmlPreview } from './types';
import { MailGraphError } from './errors';
import { reencodeMailImage, MAX_MAIL_IMAGE_INPUT, MAX_MAIL_IMAGE_TOTAL_INPUT } from './images';

const maxHtml = 1_000_000;
const maxNodes = 20_000;
const maxImages = 8;
let activeImagePreviews = 0;
const color = /^(?:#[a-f0-9]{3,8}|[a-z]{1,24}|rgba?\([0-9.,% ]{1,48}\))$/i;
const length = '(?:0|[0-9]{1,2}(?:\\.[0-9]{1,2})?(?:px|pt)|[0-4](?:\\.[0-9]{1,2})?em)';
const spacing = new RegExp(`^${length}(?: ${length}){0,3}$`);
const dimension = /^(?:auto|0|[0-9]{1,4}(?:px|pt)|(?:[0-9]{1,2}|100)%)$/;
const styles: Record<string, RegExp[]> = {
  color: [color],
  'background-color': [color],
  'font-family': [/^[a-z0-9 ,"'_-]{1,160}$/i],
  'font-size': [
    /^(?:[0-9]{1,2}(?:\.[0-9]{1,2})?(?:px|pt)|[0-4](?:\.[0-9]{1,2})?em|(?:[0-9]{1,2}|[12][0-9]{2})%|small|medium|large|x-small|x-large)$/,
  ],
  'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
  'font-style': [/^(?:normal|italic|oblique)$/],
  'text-decoration': [
    /^(?:none|underline|line-through|overline)(?: (?:underline|line-through|overline)){0,2}$/,
  ],
  'text-align': [/^(?:left|right|center|justify|start|end)$/],
  'vertical-align': [/^(?:top|middle|bottom|baseline|sub|super|text-top|text-bottom)$/],
  'line-height': [
    /^(?:normal|[0-4](?:\.[0-9]{1,2})?|[0-9]{1,2}(?:px|pt)|(?:[0-9]{1,2}|[12][0-9]{2})%)$/,
  ],
  'white-space': [/^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/],
  'word-break': [/^(?:normal|break-all|keep-all|break-word)$/],
  'overflow-wrap': [/^(?:normal|break-word|anywhere)$/],
  'border-collapse': [/^(?:collapse|separate)$/],
  'table-layout': [/^(?:auto|fixed)$/],
  'border-color': [color],
  'border-style': [/^(?:none|solid|dashed|dotted|double)$/],
  'border-width': [/^[0-5](?:px|pt)$/],
  border: [/^[0-5](?:px|pt) (?:solid|dashed|dotted|double) (?:#[a-f0-9]{3,8}|[a-z]{1,24})$/i],
  width: [dimension],
  height: [dimension],
  'max-width': [dimension],
};
for (const prefix of ['margin', 'padding']) {
  styles[prefix] = [spacing];
  for (const side of ['top', 'right', 'bottom', 'left']) styles[`${prefix}-${side}`] = [spacing];
}
const tags = [
  'a',
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
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function cidKey(value: string): string | undefined {
  const key = value.replace(/^<(.+)>$/, '$1');
  // eslint-disable-next-line no-control-regex -- CID references cannot contain whitespace or control bytes.
  if (key && key.length <= 255 && !/[\u0000-\u0020\u007f]/.test(key)) return key;
}

function cid(value: string): string | undefined {
  if (!/^cid:/i.test(value)) return;
  try {
    return cidKey(decodeURIComponent(value.slice(4)));
  } catch {
    /* Invalid references stay blocked. */
  }
}

/** Parse hostile HTML with a maintained sanitizer before any image lookup. */
export function sanitizeMailPreview(
  html: string,
  images: ReadonlyMap<string, string> = new Map(),
  linksEnabled = false,
) {
  const references = new Set<string>();
  let blockedImages = 0;
  let nodes = 0;
  let imageBytes = 0;
  let imageCount = 0;
  const clean = sanitizeHtml(html.slice(0, maxHtml), {
    allowedTags: tags,
    allowedAttributes: {
      '*': ['style', 'dir'],
      img: ['src', 'alt', 'width', 'height'],
      a: ['href', 'target', 'rel', 'referrerpolicy', 'title'],
      td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      table: ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'align'],
      col: ['span', 'width'],
    },
    allowedStyles: { '*': styles },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ['data'], a: ['https'] },
    allowProtocolRelative: false,
    nestingLimit: 32,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'title',
      'head',
      'template',
      'noscript',
      'svg',
      'math',
      'iframe',
      'object',
      'embed',
    ],
    onOpenTag: () => {
      if (++nodes > maxNodes) throw new MailGraphError(413);
    },
    transformTags: {
      '*': (name, attributes) => {
        const attribs = { ...attributes };
        // eslint-disable-next-line no-control-regex -- Reject CSS escapes and control bytes before the style allowlist.
        if (attribs.style?.length > 2048 || /[\\\u0000-\u001f]/.test(attribs.style || ''))
          delete attribs.style;
        if (attribs.dir && !/^(?:ltr|rtl|auto)$/.test(attribs.dir)) delete attribs.dir;
        for (const key of ['width', 'height']) {
          if (attribs[key] && !/^(?:[0-9]{1,4}|(?:[0-9]{1,2}|100)%)$/.test(attribs[key]))
            delete attribs[key];
        }
        for (const key of ['colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'span']) {
          if (attribs[key] && !/^[0-9]{1,2}$/.test(attribs[key])) delete attribs[key];
        }
        for (const key of ['align', 'valign']) {
          if (
            attribs[key] &&
            !/^(?:left|right|center|justify|top|middle|bottom|baseline)$/.test(attribs[key])
          )
            delete attribs[key];
        }
        if (name === 'a') {
          const link = linksEnabled === true && mailPreviewLink(attribs.href || '');
          if (!link) return { tagName: 'span', attribs: { style: attribs.style || '' } };
          return {
            tagName: 'a',
            attribs: {
              style: attribs.style || '',
              href: link.href,
              target: '_blank',
              rel: 'noopener noreferrer',
              referrerpolicy: 'no-referrer',
              title: link.viaSafeLinks
                ? 'erp.rzcloud.ch über Microsoft Safe Links in neuem Tab öffnen'
                : 'erp.rzcloud.ch in neuem Tab öffnen',
            },
          };
        }
        if (name === 'font') {
          const legacy = [];
          if (attribs.face && styles['font-family'][0].test(attribs.face))
            legacy.push(`font-family:${attribs.face}`);
          if (attribs.color && color.test(attribs.color)) legacy.push(`color:${attribs.color}`);
          const sizes: Record<string, string> = {
            '1': '8pt',
            '2': '10pt',
            '3': '12pt',
            '4': '14pt',
            '5': '18pt',
            '6': '24pt',
            '7': '36pt',
          };
          if (sizes[attribs.size]) legacy.push(`font-size:${sizes[attribs.size]}`);
          return { tagName: 'span', attribs: { style: legacy.join(';') } };
        }
        if (name !== 'img') return { tagName: name, attribs };
        const reference = cid(attribs.src || '');
        if (reference && references.size < maxImages) references.add(reference);
        const image = reference && images.get(reference);
        if (
          !image ||
          imageCount >= maxImages ||
          imageBytes + image.length > 3_000_000 ||
          !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(image)
        ) {
          blockedImages++;
          return { tagName: 'span', attribs: {}, text: '[Bild nicht geladen]' };
        }
        imageCount++;
        imageBytes += image.length;
        return {
          tagName: 'img',
          attribs: {
            src: image,
            alt: (attribs.alt || 'Eingebettetes Bild').slice(0, 300),
            ...(attribs.width && { width: attribs.width }),
            ...(attribs.height && { height: attribs.height }),
          },
        };
      },
    },
  });
  return { html: clean, blockedImages, references };
}

type GraphCall = (
  path: string,
  method?: string,
  body?: unknown,
  etag?: string,
  format?: 'text' | 'html',
  timeout?: number,
) => Promise<Record<string, unknown>>;

export function createPreviewOperation({
  call,
  raw,
  id,
  beforeRequest,
  linksEnabled = false,
}: {
  linksEnabled?: boolean;
  call: GraphCall;
  raw: (path: string, timeout: number) => Promise<Response>;
  id: (value: string) => string;
  beforeRequest: () => Promise<void>;
}) {
  const operation = async (value: string, loadImages: boolean): Promise<MailHtmlPreview> => {
    const deadline = Date.now() + 25_000;
    const remaining = () => {
      const budget = deadline - Date.now();
      if (budget <= 0) throw new MailGraphError(0);
      return budget;
    };
    const path = `/v1.0/me/messages/${id(value)}`;
    const data = await call(
      `${path}?$select=id,body`,
      'GET',
      undefined,
      undefined,
      'html',
      remaining(),
    );
    if (data.id !== value) throw new MailGraphError(409);
    const body = data.body as { content?: unknown; contentType?: unknown } | undefined;
    if (typeof body?.content !== 'string') throw new MailGraphError(502);
    let truncated = body.content.length > maxHtml;
    let html = body.content.slice(0, maxHtml);
    const warnings: string[] = [];
    if (String(body.contentType).toLowerCase() !== 'html') html = `<pre>${escape(html)}</pre>`;
    truncated ||= html.length > maxHtml;
    let first: ReturnType<typeof sanitizeMailPreview>;
    try {
      first = sanitizeMailPreview(html, new Map(), linksEnabled);
    } catch {
      truncated = true;
      html =
        '<p>Diese Mail ist zu komplex für die sichere Vorschau. Bitte öffne sie in Outlook.</p>';
      first = sanitizeMailPreview(html, new Map(), linksEnabled);
    }
    if (loadImages && first.references.size) {
      const images = new Map<string, string>();
      const metadata = await call(
        `${path}/attachments?$select=id,contentType,size,isInline,microsoft.graph.fileAttachment/contentId&$top=100`,
        'GET',
        undefined,
        undefined,
        'text',
        remaining(),
      );
      await beforeRequest();
      if (!Array.isArray(metadata.value) || metadata.value.length > 100)
        throw new MailGraphError(502);
      const candidates = new Map<string, Record<string, unknown>[]>();
      for (const row of metadata.value) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MailGraphError(502);
        const key = typeof row.contentId === 'string' && cidKey(row.contentId);
        if (key && first.references.has(key))
          candidates.set(key, [...(candidates.get(key) ?? []), row]);
      }
      let inputBytes = 0;
      let outputBytes = 0;
      if (!metadata['@odata.nextLink']) {
        for (const reference of first.references) {
          const entries = candidates.get(reference);
          if (!entries || entries.length !== 1) continue;
          const file = entries[0];
          if (
            file['@odata.type'] !== '#microsoft.graph.fileAttachment' ||
            file.isInline !== true ||
            typeof file.id !== 'string' ||
            !file.id ||
            file.id.length > 2048 ||
            !['image/png', 'image/jpeg'].includes(String(file.contentType)) ||
            !Number.isSafeInteger(file.size) ||
            Number(file.size) <= 0 ||
            Number(file.size) > MAX_MAIL_IMAGE_INPUT ||
            Number(file.size) + inputBytes > MAX_MAIL_IMAGE_TOTAL_INPUT
          )
            continue;
          const response = await raw(`${path}/attachments/${id(file.id)}/$value`, remaining());
          if (!response.body) throw new MailGraphError(502);
          const limit = Math.min(MAX_MAIL_IMAGE_INPUT, MAX_MAIL_IMAGE_TOTAL_INPUT - inputBytes);
          const declaredSize = response.headers.get('content-length');
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let size = 0;
          let oversized =
            declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > limit);
          try {
            await beforeRequest();
            while (!oversized) {
              remaining();
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > limit) {
                oversized = true;
                break;
              }
              chunks.push(Buffer.from(part.value));
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          inputBytes += Math.min(size, limit);
          await beforeRequest();
          remaining();
          if (oversized) continue;
          const image = await reencodeMailImage(Buffer.concat(chunks), String(file.contentType));
          await beforeRequest();
          remaining();
          if (!image || outputBytes + image.length > 3_000_000) continue;
          images.set(reference, image);
          outputBytes += image.length;
        }
      }
      first = sanitizeMailPreview(html, images, linksEnabled);
      if (first.blockedImages)
        warnings.push(
          'Einige Bilder bleiben gesperrt. Nur eindeutig zugeordnete eingebettete PNG- und JPEG-Bilder innerhalb der Sicherheitsgrenzen werden geladen.',
        );
    }
    await beforeRequest();
    return {
      html: first.html,
      blockedImages: first.blockedImages,
      truncated,
      warnings,
      linksEnabled: linksEnabled === true,
      embeddedImagesAvailable: first.references.size > 0,
      imagesLoaded: loadImages,
    };
  };
  return async (value: string, loadImages = false): Promise<MailHtmlPreview> => {
    if (loadImages !== true) return operation(value, false);
    if (activeImagePreviews >= 2) throw new MailGraphError(429);
    activeImagePreviews++;
    try {
      return await operation(value, true);
    } finally {
      activeImagePreviews--;
    }
  };
}
