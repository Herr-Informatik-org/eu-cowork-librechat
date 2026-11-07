import type { LocalFolderRequest, LocalFolderResult } from 'librechat-data-provider';
import type { FolderInput } from './reader';
import { readDocx, readPdf } from './documents';
import type { DocumentPart } from './documents';

const BLOCK = 64 * 1024;
const SCAN_LIMIT = 64 * 1024 * 1024;
const TEXT_EXTENSIONS =
  /\.(?:txt|log|csv|tsv|json|jsonl|ndjson|md|markdown|xml|yaml|yml|ini|conf|cfg|toml|html?|css|js|jsx|ts|tsx|py|sh|sql|java|c|cpp|h|go|rs|rb|php|properties|out|err)$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
interface Entry {
  path: string;
  kind: 'file' | 'directory';
  file?: () => Promise<File>;
}
interface Progress {
  signature: string;
  iterator?: AsyncGenerator<Entry>;
  pending?: Entry;
  file?: File;
  path: string;
  offset: number;
  page: number;
  initialOffset?: number;
  initialPage?: number;
  skipped?: number;
  inspectTail?: string;
  modified?: number;
  size?: number;
}
type Coverage = LocalFolderResult['coverage'];

/** Preserve UTF-16 offsets when folding case; expanding mappings remain literal. */
function fold(text: string): string {
  return text.replace(/[A-Z\u0080-\u{10ffff}]/gu, (value) => {
    const lower = value.toLowerCase();
    return lower.length === value.length ? lower : value;
  });
}

function normalizePath(path = ''): string {
  if (
    path.length > 512 ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.includes('\\') ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error('Nur relative Pfade innerhalb des freigegebenen Ordners sind erlaubt.');
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '.' || (part === '' && path !== ''))) {
    throw new Error('Ungültiger relativer Ordnerpfad.');
  }
  return path;
}

function readablePath(path: string): boolean {
  try {
    return normalizePath(path).length > 0;
  } catch {
    return false;
  }
}

function textBytes(bytes: Uint8Array, final: boolean): { text: string; length: number } {
  let length = bytes.length;
  if (!final && length) {
    let start = length - 1;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
    const first = bytes[start];
    let needed = 1;
    if (first >= 0xf0) needed = 4;
    else if (first >= 0xe0) needed = 3;
    else if (first >= 0xc0) needed = 2;
    if (length - start < needed) length = start;
  }
  const text = decoder.decode(bytes.subarray(0, length));
  if (text.includes('\0'))
    throw new Error('Binärdatei oder nicht unterstützte Textkodierung; bitte UTF-8 verwenden.');
  return { text, length };
}

export function createFolderEngine(input: FolderInput) {
  const cursors = new Map<string, Progress>();
  const rootName = input.files?.[0]?.webkitRelativePath?.split('/')[0];
  const fallbackPath = (file: File) =>
    file.webkitRelativePath
      ? file.webkitRelativePath.slice((rootName?.length ?? 0) + 1)
      : file.name;

  async function directory(path: string): Promise<FileSystemDirectoryHandle> {
    if (!input.handle) throw new Error('Ordner ist nicht mehr verbunden.');
    let handle = input.handle;
    for (const part of path ? path.split('/') : []) handle = await handle.getDirectoryHandle(part);
    return handle;
  }

  async function getFile(path: string): Promise<File> {
    if (!path) throw new Error('Bitte einen konkreten Dateipfad angeben.');
    if (input.handle) {
      const segments = path.split('/');
      const name = segments.pop() as string;
      return (await (await directory(segments.join('/'))).getFileHandle(name)).getFile();
    }
    const file = input.files?.find((candidate) => fallbackPath(candidate) === path);
    if (!file) throw new Error('Datei wurde im freigegebenen Ordner nicht gefunden.');
    return file;
  }

  async function* entries(path: string, recursive: boolean, depth = 0): AsyncGenerator<Entry> {
    if (depth > 32)
      throw new Error('Maximale Ordnertiefe erreicht. Bitte einen Unterordner auswählen.');
    if (!input.handle) {
      const seen = new Set<string>();
      const prefix = path ? path + '/' : '';
      for (const file of input.files ?? []) {
        const full = fallbackPath(file);
        if (!full.startsWith(prefix)) continue;
        const remainder = full.slice(prefix.length);
        if (recursive || !remainder.includes('/')) {
          yield { path: full, kind: 'file', file: async () => file };
        } else {
          const child = prefix + remainder.split('/')[0];
          if (!seen.has(child)) {
            if (seen.size >= 10_000)
              throw new Error('Mehr als 10 000 Unterordner. Bitte enger eingrenzen.');
            seen.add(child);
            yield { path: child, kind: 'directory' };
          }
        }
      }
      return;
    }
    const handle = await directory(path);
    const iterator = (
      handle as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name, child] of iterator) {
      const full = path ? path + '/' + name : name;
      if (child.kind === 'directory') {
        if (recursive) yield* entries(full, true, depth + 1);
        else yield { path: full, kind: 'directory' };
      } else {
        yield { path: full, kind: 'file', file: () => (child as FileSystemFileHandle).getFile() };
      }
    }
  }

  async function* searchEntries(path: string): AsyncGenerator<Entry> {
    if (path) {
      try {
        const file = await getFile(path);
        yield { path, kind: 'file', file: async () => file };
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') throw error;
      }
    }
    yield* entries(path, true);
  }

  function save(state: Progress): string {
    while (cursors.size >= 16) {
      const oldest = cursors.keys().next().value;
      if (oldest) cursors.delete(oldest);
    }
    const key = crypto.randomUUID();
    cursors.set(key, state);
    return key;
  }

  return {
    async execute(request: LocalFolderRequest): Promise<LocalFolderResult> {
      const coverage: Coverage = {
        complete: false,
        filesVisited: 0,
        filesRead: 0,
        bytesRead: 0,
        skipped: 0,
      };
      const maxChars = Math.min(16000, Math.floor(request.maxChars));
      try {
        if (request.folderId !== input.id || !Number.isFinite(maxChars) || maxChars < 512) {
          throw new Error('Ungültige Ordnerfreigabe oder Ergebnisgrenze.');
        }
        if (maxChars < 2048)
          throw new Error('Zu wenig Kontextbudget. Bitte einen neuen Chat starten.');
        const path = normalizePath(request.path);
        if (
          (request.startByte !== undefined &&
            (!Number.isSafeInteger(request.startByte) || request.startByte < 0)) ||
          (request.page !== undefined && (!Number.isSafeInteger(request.page) || request.page < 1))
        )
          throw new Error('Ungültiger Bytebereich oder PDF-Seite.');
        if (
          (request.startByte !== undefined || request.page !== undefined) &&
          !['read', 'inspect'].includes(request.operation)
        )
          throw new Error('Startbereich nur für Lesen oder Prüfen verwenden.');
        if (request.startByte !== undefined && /\.(pdf|docx)$/i.test(path))
          throw new Error('Bytepositionen gelten nur für UTF-8-Text. PDF bitte über page lesen.');
        if (request.page !== undefined && !/\.pdf$/i.test(path))
          throw new Error('Seitenangaben gelten nur für PDF.');
        const signature = JSON.stringify([request.operation, path, request.query ?? '']);
        const state = request.cursor
          ? cursors.get(request.cursor)
          : ({
              signature,
              path,
              offset: request.startByte ?? 0,
              page: request.page ?? 1,
              initialOffset: request.startByte ?? 0,
              initialPage: request.page ?? 1,
            } as Progress);
        if (!state || state.signature !== signature)
          throw new Error(
            'Fortsetzung ist abgelaufen oder gehört zu einer anderen Abfrage. Bitte ohne Cursor neu starten.',
          );
        if (request.cursor) cursors.delete(request.cursor);
        if (
          input.handle &&
          (await (
            input.handle as FileSystemDirectoryHandle & {
              queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
            }
          ).queryPermission({ mode: 'read' })) !== 'granted'
        ) {
          throw new DOMException(
            'Ordnerberechtigung fehlt. Bitte den Ordner erneut verbinden.',
            'NotAllowedError',
          );
        }
        const result: LocalFolderResult = { status: 'partial', coverage };
        const deadline = Date.now() + 15_000;
        const readPaths = new Set<string>();
        const remaining = () => maxChars - JSON.stringify(result).length - 650;
        const continueWith = () => {
          result.nextCursor = save(state);
        };

        if (request.operation === 'list') {
          result.entries = [];
          state.iterator ??= entries(path, false);
          while (
            Date.now() < deadline &&
            coverage.filesVisited < 1000 &&
            result.entries.length < 200
          ) {
            const next = state.pending
              ? { value: state.pending, done: false }
              : await state.iterator.next();
            state.pending = undefined;
            if (next.done) {
              coverage.complete = true;
              break;
            }
            coverage.filesVisited++;
            const entry = next.value;
            if (!readablePath(entry.path)) {
              coverage.skipped++;
              continue;
            }
            const file = entry.file ? await entry.file() : undefined;
            const listed = {
              path: entry.path,
              kind: entry.kind,
              ...(file ? { size: file.size } : {}),
            };
            if (JSON.stringify(listed).length + 2 > remaining()) {
              if (result.entries.length === 0) {
                coverage.skipped++;
                continue;
              }
              state.pending = entry;
              break;
            }
            result.entries.push(listed);
          }
          if (!coverage.complete) continueWith();
        } else if (request.operation === 'read' || request.operation === 'inspect') {
          const file = await getFile(path);
          if (
            state.modified !== undefined &&
            (state.modified !== file.lastModified || state.size !== file.size)
          ) {
            throw new Error('Datei wurde verändert. Bitte die Abfrage ohne Cursor neu starten.');
          }
          state.modified = file.lastModified;
          state.size = file.size;
          coverage.filesVisited = coverage.filesRead = 1;
          coverage.bytesTotal = file.size;
          if (!/\.(pdf|docx)$/i.test(path) && state.offset > file.size)
            throw new Error('Byteposition liegt hinter dem Dateiende.');
          if (!request.cursor && request.startByte && state.offset < file.size) {
            const prefix = new Uint8Array(
              await file.slice(state.offset, state.offset + 4).arrayBuffer(),
            );
            let adjustment = 0;
            while (adjustment < prefix.length && (prefix[adjustment] & 0xc0) === 0x80) adjustment++;
            state.offset += adjustment;
          }
          result.source = { path, byteStart: state.offset };
          if (/\.(pdf|docx)$/i.test(path)) {
            const part = /\.pdf$/i.test(path)
              ? await readPdf(
                  file,
                  state.page,
                  state.offset,
                  Math.max(50, Math.floor(remaining() / 6)),
                )
              : await readDocx(file, state.offset, Math.max(50, Math.floor(remaining() / 6)));
            result.text = part.text;
            result.source = { path, ...(part.page ? { page: part.page } : {}) };
            coverage.bytesRead = part.bytesRead;
            coverage.pagesVisited = part.page ? 1 : undefined;
            coverage.pagesTotal = part.pagesTotal;
            coverage.complete = part.nextOffset === undefined;
            if (!coverage.complete) {
              state.offset = part.nextOffset ?? 0;
              state.page = part.nextPage ?? 1;
              continueWith();
            }
            if (!part.text.trim())
              result.message =
                'Kein Text in diesem Abschnitt. Bildinhalte werden nicht erkannt; gegebenenfalls OCR erforderlich.';
          } else if (TEXT_EXTENSIONS.test(path) || !path.split('/').pop()?.includes('.')) {
            if (request.operation === 'read') {
              const end = Math.min(
                file.size,
                state.offset + Math.max(4, Math.floor(remaining() / 6)),
              );
              const bytes = new Uint8Array(await file.slice(state.offset, end).arrayBuffer());
              const decoded = textBytes(bytes, end === file.size);
              result.text = decoded.text;
              state.offset += decoded.length;
              coverage.bytesRead = bytes.length;
              result.source.byteEnd = state.offset;
              coverage.complete = state.offset >= file.size;
            } else {
              let lines = 0,
                errors = 0,
                warnings = 0;
              let tail = state.inspectTail ?? '';
              while (
                state.offset < file.size &&
                coverage.bytesRead < SCAN_LIMIT &&
                Date.now() < deadline
              ) {
                const end = Math.min(
                  file.size,
                  state.offset + Math.min(BLOCK, SCAN_LIMIT - coverage.bytesRead),
                );
                const bytes = new Uint8Array(await file.slice(state.offset, end).arrayBuffer());
                const decoded = textBytes(bytes, end === file.size);
                lines += (decoded.text.match(/\n/g) ?? []).length;
                const scan = tail + decoded.text;
                const trailing = end < file.size ? (/[A-Za-z0-9_]+$/.exec(scan)?.[0] ?? '') : '';
                const settled = trailing ? scan.slice(0, -trailing.length) : scan;
                errors += [...settled.matchAll(/\b(?:error|fatal|exception)\b/gi)].length;
                warnings += [...settled.matchAll(/\b(?:warn|warning)\b/gi)].length;
                tail = trailing.length > 16 ? 'x' + trailing.slice(-16) : trailing;
                state.inspectTail = tail;
                state.offset += decoded.length;
                coverage.bytesRead += bytes.length;
              }
              result.source.byteEnd = state.offset;
              coverage.complete = state.offset >= file.size;
              result.text = `UTF-8-Text, Dateigrösse ${file.size} Bytes. Im angegebenen Bytebereich: ${lines} Zeilenumbrüche, ${errors} Vorkommen von error/fatal/exception, ${warnings} von warn/warning. Dies sind Suchwortzählungen, keine inhaltliche Bewertung.`;
            }
            if (!coverage.complete) continueWith();
          } else {
            result.status = 'unsupported';
            coverage.skipped = 1;
            result.message =
              'Dieses Format ist lokal nicht lesbar. Unterstützt: UTF-8-Text/Logs, PDF-Text und DOCX-Haupttext. Archive, Bilder, XLSX und alte Office-Formate bitte gezielt konvertieren.';
          }
        } else if (request.operation === 'search') {
          if (!request.query?.trim() || request.query.length > 200)
            throw new Error(
              'Bitte einen Suchtext mit 1 bis 200 Zeichen angeben; reguläre Ausdrücke werden nicht ausgeführt.',
            );
          const query = fold(request.query);
          state.iterator ??= searchEntries(path);
          result.matches = [];
          let stopped = false;
          while (
            Date.now() < deadline &&
            coverage.bytesRead < SCAN_LIMIT &&
            coverage.filesVisited < 1000 &&
            result.matches.length < 100
          ) {
            if (remaining() < 850) {
              stopped = true;
              break;
            }
            if (!state.file) {
              const next = await state.iterator.next();
              if (next.done) {
                coverage.complete = true;
                break;
              }
              coverage.filesVisited++;
              state.path = next.value.path;
              if (!readablePath(state.path) || !next.value.file) {
                coverage.skipped++;
                continue;
              }
              state.file = await next.value.file();
              state.offset = 0;
              state.page = 1;
            }
            const file = state.file;
            if (SCAN_LIMIT - coverage.bytesRead < 4) break;
            readPaths.add(state.path);
            coverage.filesRead = readPaths.size;
            coverage.filesVisited = Math.max(coverage.filesVisited, readPaths.size);
            if (/\.(pdf|docx)$/i.test(state.path)) {
              // Document text is searched incrementally with page/text continuation.
              let part: DocumentPart;
              try {
                part = /\.pdf$/i.test(state.path)
                  ? await readPdf(file, state.page, state.offset, 2000)
                  : await readDocx(file, state.offset, 2000);
              } catch {
                coverage.skipped++;
                state.file = undefined;
                continue;
              }
              coverage.bytesRead += part.bytesRead;
              const index = fold(part.text).indexOf(query);
              if (index >= 0) {
                const match = {
                  path: state.path,
                  text: part.text.slice(Math.max(0, index - 100), index + query.length + 150),
                  ...(part.page ? { page: part.page } : {}),
                };
                if (JSON.stringify(match).length + 2 > remaining()) {
                  stopped = true;
                  break;
                }
                result.matches.push(match);
                state.offset += index + query.length;
              } else if (part.nextOffset !== undefined) {
                if (part.nextPage && part.nextPage !== state.page) state.offset = part.nextOffset;
                else {
                  let cut = Math.max(1, part.nextOffset - part.offset - query.length + 1);
                  if (
                    /[\uD800-\uDBFF]/.test(part.text[cut - 1]) &&
                    /[\uDC00-\uDFFF]/.test(part.text[cut] ?? '')
                  )
                    cut--;
                  state.offset =
                    part.offset + (cut || (part.text.codePointAt(0)! > 0xffff ? 2 : 1));
                }
                state.page = part.nextPage ?? 1;
              } else state.file = undefined;
              continue;
            }
            if (!TEXT_EXTENSIONS.test(state.path) && state.path.split('/').pop()?.includes('.')) {
              coverage.skipped++;
              state.file = undefined;
              continue;
            }
            const end = Math.min(
              file.size,
              state.offset + Math.min(BLOCK, SCAN_LIMIT - coverage.bytesRead),
            );
            const bytes = new Uint8Array(await file.slice(state.offset, end).arrayBuffer());
            coverage.bytesRead += bytes.length;
            let decoded;
            try {
              decoded = textBytes(bytes, end === file.size);
            } catch {
              coverage.skipped++;
              state.file = undefined;
              continue;
            }
            const index = fold(decoded.text).indexOf(query);
            if (index >= 0) {
              const byteStart = state.offset + encoder.encode(decoded.text.slice(0, index)).length;
              const byteEnd =
                state.offset + encoder.encode(decoded.text.slice(0, index + query.length)).length;
              const match = {
                path: state.path,
                byteStart,
                byteEnd,
                text: decoded.text.slice(Math.max(0, index - 100), index + query.length + 150),
              };
              if (JSON.stringify(match).length + 2 > remaining()) {
                stopped = true;
                break;
              }
              result.matches.push(match);
              state.offset = byteEnd;
            } else if (end >= file.size) state.file = undefined;
            else {
              let cut = Math.max(1, decoded.text.length - query.length + 1);
              if (
                /[\uD800-\uDBFF]/.test(decoded.text[cut - 1]) &&
                /[\uDC00-\uDFFF]/.test(decoded.text[cut] ?? '')
              )
                cut--;
              state.offset += encoder.encode(decoded.text.slice(0, cut)).length;
            }
          }
          if (!coverage.complete || stopped) continueWith();
          if (coverage.skipped)
            result.message =
              'Nicht unterstützte oder nicht lesbare Dateien wurden übersprungen; daraus folgt keine Aussage über deren Inhalt.';
        } else throw new Error('Unbekannte Ordneroperation.');
        state.skipped = (state.skipped ?? 0) + coverage.skipped;
        coverage.skipped = state.skipped;
        if ((state.initialOffset ?? 0) > 0 || (state.initialPage ?? 1) > 1) {
          coverage.complete = false;
          coverage.reason =
            'Nur der angeforderte Startbereich und folgende Abschnitte wurden gelesen; frühere Bereiche sind ungeprüft.';
        }
        if (result.status !== 'unsupported')
          result.status = coverage.complete && !coverage.skipped ? 'ok' : 'partial';
        if (coverage.skipped) {
          coverage.complete = false;
          coverage.reason =
            'Mindestens eine Datei wurde übersprungen; deren Inhalt wurde nicht geprüft.';
        }
        if (!coverage.complete && result.nextCursor)
          coverage.reason =
            'Abschnitts-, Ergebnis- oder Zeitgrenze. Für weitere Bereiche denselben Auftrag mit nextCursor fortsetzen.';
        if (JSON.stringify(result).length > maxChars)
          throw new Error(
            'Ergebnisgrenze erreicht. Bitte den Pfad oder Suchtext enger eingrenzen.',
          );
        return result;
      } catch (error) {
        const failure: LocalFolderResult = {
          status:
            error instanceof DOMException &&
            ['NotAllowedError', 'NotFoundError'].includes(error.name)
              ? 'unavailable'
              : 'error',
          coverage,
          message:
            error instanceof Error
              ? error.message.slice(0, 250)
              : 'Lokale Abfrage fehlgeschlagen. Nicht vollständig geprüft.',
        };
        while (
          JSON.stringify(failure).length > Math.max(512, maxChars) &&
          failure.message?.length
        ) {
          failure.message = failure.message.slice(0, -10);
        }
        return failure;
      }
    },
  };
}
