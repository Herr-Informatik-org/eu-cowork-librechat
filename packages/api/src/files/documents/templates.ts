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

export async function inspectWordTemplate(data: Buffer): Promise<string> {
  if (!data.length || data.length > MAX_BYTES) {
    throw new Error('Word-Vorlage ist leer oder grösser als 10 MiB.');
  }
  const target = new URL(process.env.OFFICE_PREVIEW_RENDERER_URL || 'http://office-preview:8090');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Lokale Dokumentverarbeitung ist nicht korrekt eingerichtet.');
  }
  target.pathname = '/documents/inspect-template';
  target.search = '';
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      body: new Uint8Array(data),
      redirect: 'error',
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      'Word-Vorlage konnte lokal nicht geprüft werden. Es werden keine ungeprüften Originaldateien an das Modell gesendet.',
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
      'Word-Vorlage kann nicht sicher gelesen werden. Unverschlüsselte DOCX-Datei ohne Makros verwenden.',
    );
  const text = Buffer.concat(chunks).toString('utf8');
  const report = JSON.parse(text) as {
    format?: string;
    sha256?: string;
    binarySentToModel?: boolean;
  };
  if (
    report.format !== 'docx' ||
    report.sha256 !== createHash('sha256').update(data).digest('hex') ||
    report.binarySentToModel !== false
  ) {
    throw new Error('Vorlage und lokale Prüfung stimmen nicht überein.');
  }
  return text;
}
