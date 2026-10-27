import sharp from 'sharp';
import sanitizeHtml from 'sanitize-html';
import type { MailHtmlPreview } from './types';
import { MailGraphError } from './errors';

const maxHtml = 1_000_000;
const maxNodes = 20_000;
const maxImages = 8;
const maxImageBytes = 1_000_000;
const maxTotalImageBytes = 2_000_000;
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

function cid(value: string): string | undefined {
  if (!/^cid:/i.test(value)) return;
  try {
    const key = decodeURIComponent(value.slice(4)).replace(/^<(.+)>$/, '$1');
    // eslint-disable-next-line no-control-regex -- CID references cannot contain whitespace or control bytes.
    if (key && key.length <= 255 && !/[\u0000-\u0020\u007f]/.test(key)) return key;
  } catch {
    /* Invalid references stay blocked. */
  }
}

/** Parse hostile HTML with a maintained sanitizer before any image lookup. */
export function sanitizeMailPreview(html: string, images: ReadonlyMap<string, string> = new Map()) {
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
      td: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'width', 'height', 'align', 'valign'],
      table: ['width', 'height', 'cellpadding', 'cellspacing', 'border', 'align'],
      col: ['span', 'width'],
    },
    allowedStyles: { '*': styles },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ['data'] },
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
        if (name === 'a') return { tagName: 'span', attribs: { style: attribs.style || '' } };
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

async function boundedImage(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (!response.body) throw new MailGraphError(413);
  if (length > maxImageBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new MailGraphError(413);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MailGraphError(0)), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxImageBytes) throw new MailGraphError(413);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Decode only bounded raster formats; discard metadata and animation on re-encoding. */
export async function previewRaster(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > maxImageBytes) throw new MailGraphError(413);
  const signature = input.subarray(0, 12);
  const raster =
    signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) ||
    /^GIF8[79]a/.test(signature.toString('ascii')) ||
    (signature.subarray(0, 4).toString('ascii') === 'RIFF' &&
      signature.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!raster) throw new MailGraphError(415);
  try {
    const image = sharp(input, { limitInputPixels: 4_000_000, animated: false, failOn: 'error' });
    const metadata = await image.metadata();
    if (
      !['png', 'jpeg', 'gif', 'webp'].includes(metadata.format || '') ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 4_000_000
    )
      throw new MailGraphError(415);
    const output = await image
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .timeout({ seconds: 5 })
      .toBuffer();
    if (output.length > maxImageBytes) throw new MailGraphError(413);
    return output;
  } catch {
    throw new MailGraphError(415);
  }
}

export function createPreviewOperation({
  call,
  raw,
  id,
  beforeRequest,
}: {
  call: GraphCall;
  raw: (path: string, timeout: number) => Promise<Response>;
  id: (value: string) => string;
  beforeRequest: () => Promise<void>;
}) {
  return async (value: string): Promise<MailHtmlPreview> => {
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
      first = sanitizeMailPreview(html);
    } catch {
      truncated = true;
      html =
        '<p>Diese Mail ist zu komplex für die sichere Vorschau. Bitte öffne sie in Outlook.</p>';
      first = sanitizeMailPreview(html);
    }
    const images = new Map<string, string>();
    if (first.references.size) {
      try {
        const list = await call(
          `${path}/attachments?$select=id,contentType,size,isInline,microsoft.graph.fileAttachment/contentId&$top=100`,
          'GET',
          undefined,
          undefined,
          'text',
          remaining(),
        );
        if (!Array.isArray(list.value) || list.value.length > 100) throw new MailGraphError(502);
        const candidates = list.value.filter(
          (row: Record<string, unknown>) =>
            ['#microsoft.graph.fileAttachment', 'microsoft.graph.fileAttachment'].includes(
              String(row['@odata.type']),
            ) &&
            typeof row.contentId === 'string' &&
            first.references.has(row.contentId),
        );
        let bytes = 0;
        for (const reference of first.references) {
          const matches = candidates.filter(
            (row: Record<string, unknown>) => row.contentId === reference,
          );
          if (matches.length !== 1) continue;
          const image = matches[0];
          if (
            typeof image.id !== 'string' ||
            !Number.isSafeInteger(image.size) ||
            image.size <= 0 ||
            image.size > maxImageBytes ||
            bytes + image.size > maxTotalImageBytes ||
            !/^image\/(?:png|jpeg|gif|webp)$/i.test(String(image.contentType))
          )
            continue;
          const input = await boundedImage(
            await raw(`${path}/attachments/${id(image.id)}/$value`, remaining()),
          );
          bytes += input.length;
          if (input.length !== image.size || bytes > maxTotalImageBytes) continue;
          try {
            const encoded = await previewRaster(input);
            await beforeRequest();
            if (
              [...images.values()].reduce((size, value) => size + value.length, 0) +
                (encoded.length * 4) / 3 >
              3_000_000
            )
              continue;
            images.set(reference, `data:image/png;base64,${encoded.toString('base64')}`);
          } catch (error) {
            if (!(error instanceof MailGraphError) || [401, 403].includes(error.status))
              throw error;
          }
        }
        if (list['@odata.nextLink'])
          warnings.push('Weitere eingebettete Bilder wurden aus Grössengründen nicht geladen.');
      } catch (error) {
        if (!(error instanceof MailGraphError) || [401, 403].includes(error.status)) throw error;
        warnings.push('Einige eingebettete Bilder konnten nicht sicher geladen werden.');
      }
    }
    await beforeRequest();
    const result = sanitizeMailPreview(html, images);
    return { html: result.html, blockedImages: result.blockedImages, truncated, warnings };
  };
}
