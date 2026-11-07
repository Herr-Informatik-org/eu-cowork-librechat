import sanitizeHtml from 'sanitize-html';
import sharp from 'sharp';
import { z } from 'zod';
import type { MailSignature } from './types';

export const MAX_MAIL_SIGNATURE_HTML = 20000;
const signatureSchema = z
  .object({
    enabled: z.boolean(),
    html: z.string().max(MAX_MAIL_SIGNATURE_HTML),
    fontFamily: z.enum(['Aptos', 'Calibri', 'Arial']),
    fontSize: z.union([z.literal(10), z.literal(11), z.literal(12), z.literal(14)]),
    logo: z
      .object({
        contentBytes: z.string().min(1).max(32768),
      })
      .strict()
      .optional(),
  })
  .strict();
const spacing =
  /^(?:0|(?:[0-9]|1[0-9]|2[0-4])(?:px|pt))(?: (?:0|(?:[0-9]|1[0-9]|2[0-4])(?:px|pt))){0,3}$/;
const logoMarker = '<span data-kisuno-signature-logo="true">[Signatur-Logo]</span>';
const logoPattern =
  /<span data-kisuno-signature-logo="true"(?: data-kisuno-signature-width="(\d{2,3})")?>\[Signatur-Logo\]<\/span>/;
function sizedLogoMarker(width?: string): string {
  return width
    ? logoMarker.replace('="true"', `="true" data-kisuno-signature-width="${width}"`)
    : logoMarker;
}
const logoSlot = '<br data-kisuno-signature-slot="true" />';

function normalizeFontSizes(style: string): string {
  return style
    .split(';')
    .map((declaration) => {
      if (declaration.includes('!')) return '';
      const match = declaration.match(/^\s*font-size\s*:\s*(\d{1,3}(?:\.\d{1,6})?)\s*(pt|px)\s*$/i);
      if (!match) return declaration;
      const size =
        Math.round(Number(match[1]) * (match[2].toLowerCase() === 'px' ? 0.75 : 1) * 100) / 100;
      return size >= 8 && size <= 16 ? `font-size:${size}pt` : '';
    })
    .join(';');
}

/** User-supplied signature markup remains passive data, including after rich-text paste. */
export function sanitizeSignatureHtml(html: string): string {
  if (html.length > MAX_MAIL_SIGNATURE_HTML) throw new Error('Die Signatur ist zu lang.');
  let markerSeen = false;
  let markerWidth: string | undefined;
  return sanitizeHtml(html, {
    allowedTags: [
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
    allowedAttributes: {
      '*': ['style'],
      a: ['href', 'title'],
      td: ['colspan', 'rowspan'],
      br: ['data-kisuno-signature-slot'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^(?:#[a-f0-9]{3}|#[a-f0-9]{6}|black|white|gray|grey|navy|blue|teal|green)$/i],
        'font-family': [
          /^(?:Aptos|Calibri|Arial|sans-serif)(?:,\s*(?:Aptos|Calibri|Arial|sans-serif))*$/i,
        ],
        'font-size': [/^(?:[89](?:\.\d{1,2})?|1[0-5](?:\.\d{1,2})?|16)pt$/],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/],
        'font-style': [/^(?:normal|italic)$/],
        'text-decoration': [/^(?:none|underline|line-through)$/],
        'text-align': [/^(?:left|center|right)$/],
        'vertical-align': [/^(?:top|middle|bottom)$/],
        'line-height': [/^(?:normal|1(?:\.[0-9]{1,2})?|2)$/],
        margin: [spacing],
        padding: [spacing],
        'border-collapse': [/^(?:collapse|separate)$/],
      },
    },
    nestingLimit: 16,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'iframe',
      'object',
      'embed',
      'svg',
      'math',
      'template',
    ],
    transformTags: {
      '*': (name, attributes) => {
        let style = normalizeFontSizes(attributes.style ?? '');
        if (['p', 'div'].includes(name)) {
          const hasMargin = style.split(';').some((declaration) => {
            const match = declaration.match(/^\s*margin\s*:\s*(.*?)\s*$/i);
            return match && spacing.test(match[1]);
          });
          if (!hasMargin) style = `margin:0;${style}`;
        }
        return { tagName: name, attribs: { ...attributes, style } };
      },
      span: (name, attributes): sanitizeHtml.Tag => {
        const {
          'data-kisuno-signature-logo': marker,
          'data-kisuno-signature-slot': _slot,
          'data-kisuno-signature-width': width,
          ...rest
        } = attributes;
        if (marker !== 'true') return { tagName: name, attribs: rest };
        if (markerSeen) return { tagName: name, attribs: {}, text: '' };
        markerSeen = true;
        if (/^\d{2,3}$/.test(width ?? '') && Number(width) >= 80 && Number(width) <= 320)
          markerWidth = String(Number(width));
        // Replace marker contents with a canonical slot; any safe child tags remain outside it.
        return { tagName: 'br', attribs: { 'data-kisuno-signature-slot': 'true' }, text: '' };
      },
      br: (name, attributes) => {
        const { 'data-kisuno-signature-slot': _slot, ...rest } = attributes;
        return { tagName: name, attribs: rest };
      },
      a: (_name, attributes) => ({
        tagName: 'a',
        attribs: Object.fromEntries(
          Object.entries(attributes).filter(
            ([key, value]) => ['href', 'title', 'style'].includes(key) && value.length <= 2048,
          ),
        ),
      }),
    },
  })
    .trim()
    .replace(logoSlot, sizedLogoMarker(markerWidth));
}

export function normalizeMailSignature(value: unknown): MailSignature {
  const parsed = signatureSchema.parse(value);
  const html = sanitizeSignatureHtml(parsed.html);
  const visible = sanitizeHtml(html.replace(logoPattern, ''), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
  if (parsed.enabled && !visible)
    throw new Error('Bitte gib den Text deiner persönlichen Signatur ein.');
  if (parsed.logo) logoBytes(parsed.logo.contentBytes);
  return { ...parsed, html };
}

function logoBytes(value: string): Buffer {
  const data = Buffer.from(value, 'base64');
  if (
    data.length < 33 ||
    data.length > 24576 ||
    data.toString('base64') !== value ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.readUInt32BE(8) !== 13 ||
    data.toString('ascii', 12, 16) !== 'IHDR' ||
    !data.readUInt32BE(16) ||
    data.readUInt32BE(16) > 320 ||
    !data.readUInt32BE(20) ||
    data.readUInt32BE(20) > 160
  ) {
    throw new Error('Das Signaturlogo muss ein kleines PNG mit höchstens 320 × 160 Pixeln sein.');
  }
  return data;
}

function logoPixels(data: Buffer): Buffer {
  const chunks = [data.subarray(0, 8)];
  let offset = 8;
  let count = 0;
  while (offset + 12 <= data.length && ++count <= 128) {
    const size = data.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > data.length) throw new Error();
    const kind = data.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) throw new Error();
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(kind))
      chunks.push(data.subarray(offset, end));
    else if (!/^[a-z][A-Za-z]{3}$/.test(kind)) throw new Error();
    offset = end;
    if (kind === 'IEND') {
      if (size !== 0 || offset !== data.length) throw new Error();
      return Buffer.concat(chunks);
    }
  }
  throw new Error();
}

/** Decode only a tightly bounded PNG and produce fresh pixel data without source metadata. */
export async function sanitizeMailSignature(value: unknown): Promise<MailSignature> {
  const signature = normalizeMailSignature(value);
  if (!signature.logo) return signature;
  try {
    const input = logoPixels(logoBytes(signature.logo.contentBytes));
    const image = sharp(input, { limitInputPixels: 320 * 160, animated: false, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error();
    const output = await image.png({ compressionLevel: 9 }).toBuffer();
    logoBytes(output.toString('base64'));
    return { ...signature, logo: { ...signature.logo, contentBytes: output.toString('base64') } };
  } catch {
    throw new Error(
      'Das Signaturlogo konnte nicht sicher verarbeitet werden. Bitte wähle ein anderes PNG oder JPEG.',
    );
  }
}

export function renderMailSignature(value?: MailSignature, logoCid?: string): string {
  if (!value?.enabled) return '';
  const signature = normalizeMailSignature(value);
  const marker = logoPattern.exec(signature.html);
  let logo = '';
  if (signature.logo && logoCid) {
    if (!/^kisuno-signature-[a-f0-9-]{36}$/.test(logoCid))
      throw new Error('Ungültiger Signaturverweis.');
    const data = logoBytes(signature.logo.contentBytes);
    const width = Math.min(marker?.[1] ? Number(marker[1]) : 160, data.readUInt32BE(16));
    const height = Math.max(1, Math.round((data.readUInt32BE(20) * width) / data.readUInt32BE(16)));
    logo = `<img src="cid:${logoCid}" alt="Signatur-Logo" width="${width}" height="${height}" style="display:block;margin:8pt 0">`;
  }
  const body = marker
    ? signature.html.replace(logoPattern, logo)
    : signature.html + (logo ? `<div>${logo}</div>` : '');
  return `<!-- kisuno-mail-signature:v1 --><div style="font-family:${signature.fontFamily},Arial,sans-serif;font-size:${signature.fontSize}pt;line-height:1.2;color:#000000;margin:0 0 16pt 0">${body}</div><!-- /kisuno-mail-signature:v1 -->`;
}
