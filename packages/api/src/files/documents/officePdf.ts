import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';

export const OFFICE_PDF_MAX_BYTES: number = 10 * 1024 * 1024;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'xls', 'ods']);
const REFERENCE = /<meta name="librechat-office-pdf" content="([a-f0-9]{64}):([a-z]+)">/;
const inFlight = new Map<string, Promise<string>>();
let cacheWrite: Promise<void> = Promise.resolve();

const cacheDirectory = () =>
  process.env.OFFICE_PREVIEW_CACHE_DIR || join(tmpdir(), 'lc-office-previews');

export function parseOfficePdfReference(html: unknown): { key: string; format: string } | null {
  if (typeof html !== 'string') {
    return null;
  }
  const match = REFERENCE.exec(html);
  return match && FORMATS.has(match[2]) ? { key: match[1], format: match[2] } : null;
}

export function officePdfKey(buffer: Buffer, format: string): string {
  return createHash('sha256').update('office-pdf-v1:').update(format).update(buffer).digest('hex');
}

export async function readOfficePdf(key: string): Promise<Buffer | null> {
  if (!/^[a-f0-9]{64}$/.test(key)) {
    return null;
  }
  const path = join(cacheDirectory(), `${key}.pdf`);
  try {
    const info = await stat(path);
    if (info.size > OFFICE_PDF_MAX_BYTES || Date.now() - info.mtimeMs > CACHE_TTL_MS) {
      await rm(path, { force: true });
      return null;
    }
    return await readFile(path);
  } catch {
    return null;
  }
}

async function trimCache(incomingBytes: number): Promise<void> {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await Promise.all(
    (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}(\.pdf|-[a-f0-9-]{36}\.tmp)$/.test(name))
      .map(async (name) => {
        const path = join(directory, name);
        const info = await stat(path).catch(() => null);
        return info
          ? { path, size: info.size, time: info.mtimeMs, temporary: name.endsWith('.tmp') }
          : null;
      }),
  );
  const files = entries.filter((entry) => entry != null).sort((a, b) => a.time - b.time);
  let bytes = files.reduce((sum, file) => sum + file.size, incomingBytes);
  for (const file of files) {
    if (file.temporary && Date.now() - file.time < 60 * 60 * 1000) {
      continue;
    }
    if (file.temporary || Date.now() - file.time > CACHE_TTL_MS || bytes > CACHE_MAX_BYTES) {
      await rm(file.path, { force: true });
      bytes -= file.size;
    }
  }
  if (bytes > CACHE_MAX_BYTES) {
    throw new Error('Office-Vorschaucache ist ausgelastet');
  }
}

async function renderPdf(buffer: Buffer, format: string, key: string): Promise<string> {
  if (await readOfficePdf(key)) {
    return key;
  }
  const target = new URL(process.env.OFFICE_PREVIEW_RENDERER_URL ?? '');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Ungültige Office-Renderer-Adresse');
  }
  target.pathname = '/render';
  target.search = `format=${format}`;
  target.hash = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45_000);
  let response: Response | undefined;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(buffer),
      redirect: 'error',
      signal: abort.signal,
    });
    if (
      !response.ok ||
      response.headers.get('content-type') !== 'application/pdf' ||
      !response.body
    ) {
      throw new Error('Office-Renderer ist nicht verfügbar');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > OFFICE_PDF_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Office-PDF überschreitet 10 MiB');
      }
      chunks.push(value);
    }
    const pdf = Buffer.concat(chunks);
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('Office-Renderer hat kein PDF geliefert');
    }
    const write = cacheWrite
      .catch(() => undefined)
      .then(async () => {
        await trimCache(pdf.length);
        const tempPath = join(cacheDirectory(), `${key}-${randomUUID()}.tmp`);
        try {
          await writeFile(tempPath, pdf, { mode: 0o600, flag: 'wx' });
          await rename(tempPath, join(cacheDirectory(), `${key}.pdf`));
        } finally {
          await rm(tempPath, { force: true });
        }
      });
    cacheWrite = write;
    await write;
    return key;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** The key binds the rendered copy to the original bytes and renderer version. */
export async function prepareOfficePdf(buffer: Buffer, format: string): Promise<string> {
  if (!FORMATS.has(format) || buffer.length === 0 || buffer.length > OFFICE_PDF_MAX_BYTES) {
    throw new Error('Dokumentformat oder Grösse wird nicht unterstützt');
  }
  const key = officePdfKey(buffer, format);
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }
  if (inFlight.size >= 2) {
    throw new Error('Office-Vorschau ist ausgelastet');
  }
  const pending = renderPdf(buffer, format, key).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

export async function buildOfficePdfReference(buffer: Buffer, format: string): Promise<string> {
  const key = await prepareOfficePdf(buffer, format);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="librechat-office-pdf" content="${key}:${format}"></head><body><p>Dokumentansicht mit LibreOffice. Die bearbeitbare Originaldatei bleibt unverändert.</p></body></html>`;
}
