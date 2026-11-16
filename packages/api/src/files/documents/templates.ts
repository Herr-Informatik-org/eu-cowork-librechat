import { createHash } from 'crypto';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_INSPECTION_BYTES = 512 * 1024;
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isWordTemplate(
  filename: string | undefined,
  mimeType: string | undefined,
): boolean {
  return mimeType === DOCX_MIME || /\.docx$/i.test(filename ?? '');
}

async function inspectOfficeFile(
  data: Buffer,
  format: 'docx' | 'xlsx' | 'pdf' | 'image',
): Promise<string> {
  if (!data.length || data.length > MAX_BYTES) {
    throw new Error('Office-Datei ist leer oder grösser als 10 MiB.');
  }
  const target = new URL(process.env.OFFICE_PREVIEW_RENDERER_URL || 'http://office-preview:8090');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Lokale Dokumentverarbeitung ist nicht korrekt eingerichtet.');
  }
  target.pathname = {
    docx: '/documents/inspect-template',
    xlsx: '/documents/inspect-workbook',
    pdf: '/documents/inspect-pdf',
    image: '/documents/inspect-image',
  }[format];
  target.search = '';
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      body: new Uint8Array(data),
      redirect: 'error',
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(format === 'pdf' || format === 'image' ? 85000 : 15000),
    });
  } catch {
    throw new Error(
      'Office-Datei konnte lokal nicht geprüft werden. Es werden keine ungeprüften Originaldateien an das Modell gesendet.',
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (!response.body) throw new Error('Lokale Vorlagenprüfung lieferte keine Antwort.');
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_INSPECTION_BYTES) throw new Error('Die Vorlagenprüfung ist zu umfangreich.');
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!response.ok)
    throw new Error(
      'Office-Datei kann nicht sicher gelesen werden. Unverschlüsselte DOCX- oder XLSX-Datei ohne Makros verwenden.',
    );
  const text = Buffer.concat(chunks).toString('utf8');
  const report = JSON.parse(text) as {
    format?: string;
    sha256?: string;
    binarySentToModel?: boolean;
  };
  if (
    report.format !== format ||
    report.sha256 !== createHash('sha256').update(data).digest('hex') ||
    report.binarySentToModel !== false
  ) {
    throw new Error('Vorlage und lokale Prüfung stimmen nicht überein.');
  }
  return text;
}

export function inspectWordTemplate(data: Buffer): Promise<string> {
  return inspectOfficeFile(data, 'docx');
}
export function inspectSpreadsheet(data: Buffer): Promise<string> {
  return inspectOfficeFile(data, 'xlsx');
}
export function inspectPdfDocument(data: Buffer): Promise<string> {
  return inspectOfficeFile(data, 'pdf');
}
export function inspectImageDocument(data: Buffer): Promise<string> {
  return inspectOfficeFile(data, 'image');
}
/** Pictures are read locally where the person can choose to send originals and did not. */
export function isLocalImage(
  mimeType: string | undefined,
  metadata: { providerOriginal?: boolean } | undefined,
): boolean {
  return (
    process.env.KISUNO_ORIGINAL_UPLOAD_ENABLED === 'true' &&
    /^image\/(png|jpeg|webp)$/i.test(mimeType ?? '') &&
    metadata?.providerOriginal !== true
  );
}
export function isPdfDocument(filename: string | undefined, mimeType: string | undefined): boolean {
  return mimeType === 'application/pdf' || /\.pdf$/i.test(filename ?? '');
}
export function isSpreadsheet(filename: string | undefined, mimeType: string | undefined): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    /\.xlsx$/i.test(filename ?? '')
  );
}
