import { XMLValidator } from 'fast-xml-parser';
import { getDocument, PDFDataRangeTransport, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_PAGE_CHARS = 2_000_000;
const MAX_CACHED_TEXT_CHARS = MAX_DOCUMENT_BYTES / 2;
let docxCache: { file: File; size: number; modified: number; text: string } | undefined;
const decoder = new TextDecoder('utf-8', { fatal: true });
const wordNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

export interface DocumentPart {
  text: string;
  page?: number;
  pagesTotal?: number;
  offset: number;
  nextOffset?: number;
  nextPage?: number;
  bytesRead: number;
}

function validateSection(offset: number, maxChars: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 2 ||
    maxChars > 16000
  ) {
    throw new Error('Ungültiger Dokumentabschnitt oder Ergebnisgrenze.');
  }
}

function sectionText(text: string, maxChars: number): string {
  let end = Math.min(text.length, maxChars);
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    end--;
  return text.slice(0, end);
}

/** The PDF parser reads requested byte ranges; the worker can be terminated by the caller. */
export async function readPdf(
  file: File,
  page: number,
  offset: number,
  maxChars: number,
): Promise<DocumentPart> {
  validateSection(offset, maxChars);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('PDF-Seite existiert nicht.');
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  let bytesRead = 0;
  let stopped = false;
  let task: ReturnType<typeof getDocument> | undefined;
  let destruction: Promise<void> | undefined;
  let fail: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const destroy = () => {
    stopped = true;
    destruction ??= task?.destroy().catch(() => undefined);
    return destruction;
  };
  const reject = (message: string) => {
    fail(new Error(message));
    void destroy();
  };
  class BlobTransport extends PDFDataRangeTransport {
    abort() {
      stopped = true;
    }

    requestDataRange(begin: number, end: number) {
      if (stopped) return;
      if (
        !Number.isSafeInteger(begin) ||
        !Number.isSafeInteger(end) ||
        begin < 0 ||
        end <= begin ||
        end > file.size ||
        end - begin + bytesRead > MAX_DOCUMENT_BYTES
      ) {
        reject(
          'PDF benötigt ungültige oder mehr als 32 MiB Parserdaten pro Schritt. Bitte PDF aufteilen.',
        );
        return;
      }
      bytesRead += end - begin;
      void file
        .slice(begin, end)
        .arrayBuffer()
        .then((buffer) => {
          if (!stopped) this.onDataRange(begin, new Uint8Array(buffer));
        })
        .catch(() => reject('PDF konnte nicht lokal gelesen werden.'));
    }
  }
  const workerPort = new Worker(pdfWorkerUrl, { type: 'module' });
  let pdfWorker: PDFWorker | undefined;
  try {
    pdfWorker = PDFWorker.create({ port: workerPort });
    task = getDocument({
      worker: pdfWorker,
      range: new BlobTransport(file.size, null, true),
      length: file.size,
      rangeChunkSize: 64 * 1024,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
    });
    task.onPassword = () => reject('Passwortgeschützte PDF bitte vor der Analyse entsperren.');
    const document = await Promise.race([task.promise, failure]);
    if (page > document.numPages) throw new Error('PDF-Seite existiert nicht.');
    const pdfPage = await Promise.race([document.getPage(page), failure]);
    const reader = pdfPage.streamTextContent().getReader();
    let seen = 0;
    let text = '';
    let done = false;
    try {
      while (text.length <= maxChars && seen < MAX_PAGE_CHARS) {
        const chunk = await Promise.race([reader.read(), failure]);
        if (chunk.done) {
          done = true;
          break;
        }
        for (const item of chunk.value.items as Array<{ str?: string; hasEOL?: boolean }>) {
          if (typeof item.str !== 'string') continue;
          const value = item.str + (item.hasEOL ? '\n' : ' ');
          const start = Math.max(0, offset - seen);
          seen += value.length;
          if (seen > offset)
            text += value.slice(start, start + Math.max(0, maxChars + 1 - text.length));
          if (text.length > maxChars || seen >= MAX_PAGE_CHARS) break;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      pdfPage.cleanup();
    }
    if (seen >= MAX_PAGE_CHARS && text.length === 0) {
      throw new Error('Diese PDF-Seite ist zu komplex. Bitte das Dokument aufteilen.');
    }
    const more = !done || text.length > maxChars;
    const output = sectionText(text, maxChars);
    const continuation: Pick<DocumentPart, 'nextOffset' | 'nextPage'> = {};
    if (more) {
      continuation.nextOffset = offset + output.length;
      continuation.nextPage = page;
    } else if (page < document.numPages) {
      continuation.nextOffset = 0;
      continuation.nextPage = page + 1;
    }
    return {
      text: output,
      page,
      pagesTotal: document.numPages,
      offset,
      bytesRead,
      ...continuation,
    };
  } finally {
    try {
      await destroy();
    } finally {
      try {
        pdfWorker?.destroy();
      } finally {
        workerPort.terminate();
      }
    }
  }
}

function decodeXml(text: string): string {
  return text.replace(/&([^;]*);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    let value = 0;
    if (/^#x[\da-f]+$/i.test(entity)) value = parseInt(entity.slice(2), 16);
    else if (/^#\d+$/.test(entity)) value = Number(entity.slice(1));
    if (
      value === 9 ||
      value === 10 ||
      value === 13 ||
      (value >= 32 && value <= 0xd7ff) ||
      (value >= 0xe000 && value <= 0xfffd) ||
      (value >= 0x10000 && value <= 0x10ffff)
    ) {
      return String.fromCodePoint(value);
    }
    throw new Error('DOCX enthält eine ungültige XML-Zeichenreferenz.');
  });
}

interface XmlFrame {
  text: boolean;
  body: boolean;
  paragraph: boolean;
  previousNamespaces: Array<[string, string | undefined]>;
}

/** Validate and extract one bounded plaintext body without allocating an XML tree. */
function docxText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('DOCX-Textstruktur ist ungültig.');
  const namespaces = new Map<string, string>();
  const stack: XmlFrame[] = [];
  let output = '';
  let foundBody = false;
  const append = (value: string) => {
    if (output.length + value.length > MAX_CACHED_TEXT_CHARS)
      throw new Error(
        'DOCX-Text überschreitet 32 MiB lokalen Zwischenspeicher. Bitte Dokument aufteilen.',
      );
    output += value;
  };
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (const match of xml.matchAll(tokens)) {
    if (match[0].startsWith('<!--') || match[0].startsWith('<?')) continue;
    const parent = stack[stack.length - 1];
    if (match[1] !== undefined || match[5] !== undefined) {
      if (parent?.text && parent.body) append(match[1] ?? decodeXml(match[5]));
    } else if (match[2] === '/') {
      const frame = stack.pop();
      if (frame?.paragraph && frame.body) append('\n');
      for (const [prefix, previous] of frame?.previousNamespaces ?? []) {
        if (previous === undefined) namespaces.delete(prefix);
        else namespaces.set(prefix, previous);
      }
    } else {
      if (stack.length >= 256)
        throw new Error('DOCX-Text ist zu tief verschachtelt. Bitte Dokument aufteilen.');
      const previousNamespaces: XmlFrame['previousNamespaces'] = [];
      for (const attribute of match[4].matchAll(
        /(?:^|\s)xmlns(?::([\w.-]+))?\s*=\s*(["'])(.*?)\2/g,
      )) {
        const prefix = attribute[1] ?? '';
        previousNamespaces.push([prefix, namespaces.get(prefix)]);
        namespaces.set(prefix, decodeXml(attribute[3]));
      }
      const parts = match[3].split(':');
      const local = parts.pop();
      const word = wordNamespaces.has(namespaces.get(parts[0] ?? '') ?? '');
      if (stack.length === 0 && (!word || local !== 'document'))
        throw new Error('DOCX enthält keinen gültigen Word-Haupttext.');
      const body = Boolean(parent?.body || (word && local === 'body'));
      foundBody ||= body;
      const frame: XmlFrame = {
        body,
        text: word && local === 't',
        paragraph: word && local === 'p',
        previousNamespaces,
      };
      stack.push(frame);
      if (body && word && ['tab', 'br', 'cr'].includes(local ?? ''))
        append(local === 'tab' ? '\t' : '\n');
      if (match[0].endsWith('/>')) {
        stack.pop();
        if (frame.paragraph && frame.body) append('\n');
        for (const [prefix, previous] of previousNamespaces) {
          if (previous === undefined) namespaces.delete(prefix);
          else namespaces.set(prefix, previous);
        }
      }
    }
  }
  if (!foundBody) throw new Error('DOCX enthält keinen lesbaren Haupttext.');
  return decoder.decode(new TextEncoder().encode(output));
}

interface ZipEntry {
  flags: number;
  method: number;
  compressed: number;
  expanded: number;
  checksum: number;
  header: number;
}

/** Read only the DOCX main body; compressed images and other ZIP entries remain untouched. */
export async function readDocx(
  file: File,
  offset: number,
  maxChars: number,
): Promise<DocumentPart> {
  validateSection(offset, maxChars);
  const section = (body: string, bytesRead: number): DocumentPart => {
    const text = sectionText(body.slice(offset, offset + maxChars + 1), maxChars);
    return {
      text,
      offset,
      bytesRead,
      ...(offset + text.length < body.length ? { nextOffset: offset + text.length } : {}),
    };
  };
  if (
    docxCache?.file === file &&
    docxCache.size === file.size &&
    docxCache.modified === file.lastModified
  )
    return section(docxCache.text, 0);
  docxCache = undefined;
  let bytesRead = 0;
  const read = async (start: number, length: number) => {
    if (
      start < 0 ||
      length < 0 ||
      start + length > file.size ||
      bytesRead + length > MAX_DOCUMENT_BYTES + 3 * 1024 * 1024
    ) {
      throw new Error('Ungültiges oder zu grosses DOCX-Verzeichnis.');
    }
    bytesRead += length;
    return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  };
  const tail = await read(Math.max(0, file.size - 65557), Math.min(file.size, 65557));
  const tailView = new DataView(tail.buffer);
  let eocd = tail.length - 22;
  while (
    eocd >= 0 &&
    (tailView.getUint32(eocd, true) !== 0x06054b50 ||
      eocd + 22 + tailView.getUint16(eocd + 20, true) !== tail.length)
  )
    eocd--;
  if (
    eocd < 0 ||
    tailView.getUint16(eocd + 4, true) !== 0 ||
    tailView.getUint16(eocd + 6, true) !== 0 ||
    tailView.getUint16(eocd + 8, true) !== tailView.getUint16(eocd + 10, true)
  ) {
    throw new Error('DOCX-ZIP-Format wird nicht unterstützt.');
  }
  const count = tailView.getUint16(eocd + 10, true);
  const centralSize = tailView.getUint32(eocd + 12, true);
  const centralStart = tailView.getUint32(eocd + 16, true);
  if (count > 4096 || centralSize > 2 * 1024 * 1024 || centralStart === 0xffffffff) {
    throw new Error(
      'DOCX enthält zu viele Bestandteile oder verwendet ZIP64. Bitte Dokument aufteilen.',
    );
  }
  if (centralStart + centralSize !== file.size - tail.length + eocd)
    throw new Error('DOCX-ZIP-Verzeichnis ist unvollständig.');
  const central = await read(centralStart, centralSize);
  const view = new DataView(central.buffer);
  let cursor = 0;
  let entry: ZipEntry | undefined;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > central.length || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error('DOCX-ZIP-Verzeichnis ist ungültig.');
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    if (cursor + 46 + nameLength + extraLength + commentLength > central.length)
      throw new Error('DOCX-ZIP-Verzeichnis ist unvollständig.');
    const name = central.subarray(cursor + 46, cursor + 46 + nameLength);
    if (
      nameLength === 17 &&
      name.every((byte, index) => byte === 'word/document.xml'.charCodeAt(index))
    ) {
      if (entry) throw new Error('DOCX enthält mehrere Haupttexte und ist nicht eindeutig.');
      if (view.getUint16(cursor + 34, true) !== 0)
        throw new Error('Mehrteilige DOCX-Archive werden nicht unterstützt.');
      entry = {
        flags: view.getUint16(cursor + 8, true),
        method: view.getUint16(cursor + 10, true),
        compressed: view.getUint32(cursor + 20, true),
        expanded: view.getUint32(cursor + 24, true),
        checksum: view.getUint32(cursor + 16, true),
        header: view.getUint32(cursor + 42, true),
      };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralSize) throw new Error('DOCX-ZIP-Verzeichnis ist ungültig.');
  if (!entry) throw new Error('DOCX enthält keinen lesbaren Haupttext.');
  const { flags, method, compressed, expanded, checksum, header: headerStart } = entry;
  if (
    flags & 0x41 ||
    ![0, 8].includes(method) ||
    compressed > MAX_DOCUMENT_BYTES ||
    expanded > MAX_DOCUMENT_BYTES
  ) {
    throw new Error(
      'DOCX-Text ist verschlüsselt oder überschreitet 32 MiB. Bitte Dokument aufteilen.',
    );
  }
  const header = new DataView((await read(headerStart, 30)).buffer);
  if (
    header.getUint32(0, true) !== 0x04034b50 ||
    header.getUint16(6, true) !== flags ||
    header.getUint16(8, true) !== method
  )
    throw new Error('Ungültiger DOCX-Dateikopf.');
  const nameLength = header.getUint16(26, true);
  if (decoder.decode(await read(headerStart + 30, nameLength)) !== 'word/document.xml')
    throw new Error('DOCX-Haupttext stimmt nicht mit dem Verzeichnis überein.');
  if (
    !(flags & 8) &&
    (header.getUint32(14, true) !== checksum ||
      header.getUint32(18, true) !== compressed ||
      header.getUint32(22, true) !== expanded)
  )
    throw new Error('DOCX-Dateikopf und Verzeichnis stimmen nicht überein.');
  const dataStart = headerStart + 30 + nameLength + header.getUint16(28, true);
  if (
    dataStart + compressed > centralStart ||
    bytesRead + compressed > MAX_DOCUMENT_BYTES + 3 * 1024 * 1024
  )
    throw new Error('DOCX ist unvollständig oder zu gross.');
  bytesRead += compressed;
  const compressedStream = file.slice(dataStart, dataStart + compressed).stream() as ReadableStream<
    Uint8Array<ArrayBuffer>
  >;
  const stream =
    method === 8
      ? compressedStream.pipeThrough(
          new DecompressionStream('deflate-raw') as ReadableWritablePair<
            Uint8Array<ArrayBuffer>,
            Uint8Array<ArrayBuffer>
          >,
        )
      : compressedStream;
  const reader = stream.getReader();
  let decode: TextDecoder | undefined;
  let initial = new Uint8Array(0);
  let size = 0;
  let crc = 0xffffffff;
  let xml = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_DOCUMENT_BYTES || size > expanded)
        throw new Error('DOCX-Entpackgrenze erreicht.');
      for (const byte of chunk.value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
      let bytes = chunk.value;
      if (!decode) {
        const prefix = new Uint8Array(initial.length + bytes.length);
        prefix.set(initial);
        prefix.set(bytes, initial.length);
        bytes = prefix;
        if (bytes.length < 4) {
          initial = bytes;
          continue;
        }
        const little =
          (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0);
        const big =
          (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c);
        let encoding = 'utf-8';
        if (little) encoding = 'utf-16le';
        else if (big) encoding = 'utf-16be';
        decode = new TextDecoder(encoding, { fatal: true });
      }
      xml += decode.decode(bytes, { stream: true });
    }
    xml += decode ? decode.decode() : decoder.decode(initial);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size !== expanded || (crc ^ 0xffffffff) >>> 0 !== checksum)
    throw new Error('DOCX-Haupttext ist beschädigt oder unvollständig.');
  const text = docxText(xml);
  docxCache = { file, size: file.size, modified: file.lastModified, text };
  return section(text, bytesRead);
}
