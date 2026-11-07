import type { MailAttachmentDownload } from './types';
import type { MailAttachmentScanResult } from './scanner';
import { MailDraftError, MailGraphError } from './errors';
import { MAX_SCANNED_ATTACHMENT_BYTES } from './scanner';

export type MailAttachmentScanner = (bytes: Buffer) => Promise<MailAttachmentScanResult>;
export interface ScannedAttachmentMetadata {
  name: string;
  contentType: string;
  size: number;
}
const supported = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['txt', 'text/plain'],
]);

export function attachmentDownloadName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex -- Exclude path, header and bidi filename spoofing.
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/g, '_')
    .replace(/^\.+|[ .]+$/g, '');
  const extension = clean.slice(clean.lastIndexOf('.'));
  return `${clean.slice(0, Math.min(clean.length - extension.length, 160)) || 'Anhang'}${extension}`;
}

/** Keep the first release deliberately narrow; filename, MIME and magic must agree. */
export function assertScannableAttachment(file: ScannedAttachmentMetadata): void {
  const extension = /^.+\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase();
  if (
    !extension ||
    supported.get(extension) !== file.contentType.toLowerCase() ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_SCANNED_ATTACHMENT_BYTES
  )
    throw new MailDraftError(
      'Dieser Anhang kann nicht freigegeben werden. Unterstützt sind PDF, PNG, JPEG und UTF-8-Text bis 20 MB; Office-Dateien, Archive und ausführbare Dateien bleiben gesperrt.',
      400,
    );
}

export async function readAttachmentBytes(
  response: Response,
  size: number,
  guard: () => Promise<void>,
): Promise<Buffer> {
  if (!response.body || size <= 0 || size > MAX_SCANNED_ATTACHMENT_BYTES)
    throw new MailGraphError(502);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size)) {
    await response.body.cancel().catch(() => undefined);
    throw new MailGraphError(502);
  }
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let actual = 0;
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      await guard();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MailGraphError(0);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new MailGraphError(0)), remaining);
          timeout.unref();
        }),
      ]).finally(() => clearTimeout(timeout));
      if (part.done) break;
      actual += part.value.byteLength;
      if (actual > size || actual > MAX_SCANNED_ATTACHMENT_BYTES) throw new MailGraphError(413);
      parts.push(Buffer.from(part.value));
    }
    if (actual !== size) throw new MailGraphError(502);
    await guard();
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function checkAttachmentBytes(
  file: ScannedAttachmentMetadata,
  bytes: Buffer,
  scanner: MailAttachmentScanner,
): Promise<MailAttachmentDownload> {
  assertScannableAttachment(file);
  let matches = bytes.length === file.size;
  switch (file.contentType.toLowerCase()) {
    case 'application/pdf':
      matches &&=
        /^%PDF-(?:1\.[0-9]|2\.0)[\r\n ]/.test(bytes.subarray(0, 12).toString('ascii')) &&
        /%%EOF[\r\n\t ]*$/.test(bytes.subarray(-1024).toString('latin1'));
      break;
    case 'image/png':
      matches &&=
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
      break;
    case 'image/jpeg':
      matches &&=
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9;
      break;
    case 'text/plain':
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        // eslint-disable-next-line no-control-regex -- Download text must be plain UTF-8, not a disguised binary.
        matches &&= !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content);
      } catch {
        matches = false;
      }
      break;
  }
  if (!matches)
    throw new MailDraftError(
      'Dateiname, Dateityp und Inhalt des Anhangs stimmen nicht überein. Der Anhang bleibt gesperrt.',
    );
  const scan = await scanner(bytes);
  return { bytes, name: attachmentDownloadName(file.name), contentType: file.contentType, scan };
}
