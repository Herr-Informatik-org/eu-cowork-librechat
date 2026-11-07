import { File as NodeFile } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createFolderEngine } from './engine';
import { readPdf, readDocx } from './documents';
import type { LocalFolderRequest } from 'librechat-data-provider';

jest.mock('./documents', () => ({ readPdf: jest.fn(), readDocx: jest.fn() }));
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID });
const folderId = 'local-test';
function file(text: string, name = 'large.log') {
  return new NodeFile([text], name) as unknown as File;
}
function request(overrides: Partial<LocalFolderRequest> = {}): LocalFolderRequest {
  return { folderId, operation: 'read', path: 'large.log', maxChars: 4000, ...overrides };
}

describe('bounded local folder engine', () => {
  it('reads UTF-8 incrementally without losing or duplicating multibyte text', async () => {
    const text = 'äöü漢字🙂\n'.repeat(800);
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files: [file(text)] });
    let cursor: string | undefined;
    let actual = '';
    let calls = 0;
    do {
      const result = await engine.execute(request({ cursor }));
      expect(result.status).not.toBe('error');
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
      actual += result.text;
      cursor = result.nextCursor;
      calls++;
      expect(calls).toBeLessThan(100);
    } while (cursor);
    expect(actual).toBe(text);
  });

  it('finds a literal across block boundaries and continues to later matches', async () => {
    const text =
      'x'.repeat(65533) + 'Connection ERROR literal .*' + 'x'.repeat(1000) + '\nsecond ERROR';
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files: [file(text)] });
    const result = await engine.execute(
      request({ operation: 'search', query: 'connection error' }),
    );
    expect(result.matches?.[0]?.byteStart).toBe(65533);
    expect(result.coverage.complete).toBe(true);
    const literal = await engine.execute(request({ operation: 'search', query: '.*' }));
    expect(literal.matches).toHaveLength(1);
    expect(literal.matches?.[0]?.text).toContain('.*');
  });

  it('bounds each result and resumes dense matches without truncating JSON', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [file('error "\\\t'.repeat(1000))],
    });
    let cursor: string | undefined;
    const offsets: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await engine.execute(
        request({ operation: 'search', query: 'error', cursor, maxChars: 2500 }),
      );
      expect(result.status).toBe('partial');
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2500);
      offsets.push(...(result.matches ?? []).map((match) => match.byteStart as number));
      cursor = result.nextCursor;
      expect(cursor).toBeDefined();
    }
    expect(offsets.length).toBeGreaterThan(1);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('processes a virtual 1 GiB log in bounded slices without whole-file reads', async () => {
    let largest = 0;
    let total = 0;
    const virtual = {
      name: 'large.log',
      size: 1024 ** 3,
      lastModified: 1,
      webkitRelativePath: '',
      slice(start: number, end: number) {
        largest = Math.max(largest, end - start);
        total += end - start;
        return {
          arrayBuffer: async () => new TextEncoder().encode('x'.repeat(end - start)).buffer,
        };
      },
      arrayBuffer: () => {
        throw new Error('Whole-file read');
      },
      text: () => {
        throw new Error('Whole-file read');
      },
    } as unknown as File;
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files: [virtual] });
    const result = await engine.execute(request({ operation: 'inspect' }));
    expect(result.status).toBe('partial');
    expect(result.coverage.bytesTotal).toBe(1024 ** 3);
    expect(result.coverage.bytesRead).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(largest).toBeLessThanOrEqual(65536);
    expect(total).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(result.nextCursor).toBeDefined();
    const next = await engine.execute(request({ operation: 'inspect', cursor: result.nextCursor }));
    expect(next.source?.byteStart).toBe(result.source?.byteEnd);
  });

  it('preserves byte offsets after expanding Unicode case mappings', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [file('İ beginning ERROR end')],
    });
    const result = await engine.execute(request({ operation: 'search', query: 'error' }));
    expect(result.matches?.[0]?.byteStart).toBe(new TextEncoder().encode('İ beginning ').length);
  });

  it('keeps astral Unicode intact when retaining a search overlap', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [file('x'.repeat(65528) + '🙂' + 'aaaa' + '\nTARGET')],
    });
    const result = await engine.execute(request({ operation: 'search', query: 'TARGET' }));
    expect(result.matches).toHaveLength(1);
    expect(result.matches?.[0]?.byteStart).toBe(65537);
    expect(result.coverage.skipped).toBe(0);
  });

  it('limits dense matches to the server schema and continues the remaining hit', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [file('a'.repeat(101))],
    });
    const first = await engine.execute(
      request({ operation: 'search', query: 'a', maxChars: 16000 }),
    );
    expect(first.matches).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = await engine.execute(
      request({ operation: 'search', query: 'a', maxChars: 16000, cursor: first.nextCursor }),
    );
    expect(second.matches).toHaveLength(1);
    expect(second.matches?.[0]?.byteStart).toBe(100);
    expect(second.coverage.complete).toBe(true);
  });

  it('skips names that cannot be represented by the server path contract', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [
        file('error', 'a\\b.log'),
        file('error', 'c:bad.log'),
        file('error', 'line\nbreak.log'),
        file('error', 'good.log'),
      ],
    });
    const listed = await engine.execute(request({ operation: 'list', path: '' }));
    expect(listed.entries?.map((entry) => entry.path)).toEqual(['good.log']);
    expect(listed.coverage.skipped).toBe(3);
    const searched = await engine.execute(
      request({ operation: 'search', query: 'error', path: '' }),
    );
    expect(searched.matches?.map((entry) => entry.path)).toEqual(['good.log']);
    expect(searched.coverage.skipped).toBe(3);
  });

  it('keeps document-search overlap at a whole Unicode character', async () => {
    const text = 'x'.repeat(1994) + '🙂' + 'aaaa' + '\nTARGET';
    jest.mocked(readDocx).mockImplementation(async (_file, offset, maxChars) => ({
      text: text.slice(offset, offset + maxChars),
      offset,
      bytesRead: 10,
      ...(offset + maxChars < text.length ? { nextOffset: offset + maxChars } : {}),
    }));
    const engine = createFolderEngine({
      id: folderId,
      label: 'Docs',
      files: [file('zip', 'test.docx')],
    });
    const result = await engine.execute(
      request({ operation: 'search', query: 'TARGET', path: 'test.docx' }),
    );
    expect(readDocx).toHaveBeenNthCalledWith(2, expect.anything(), 1994, 2000);
    expect(result.matches).toHaveLength(1);
    expect(result.coverage.skipped).toBe(0);
  });

  it('retains skipped coverage across search continuation pages', async () => {
    const files = [
      file('binary', 'bad.zip'),
      ...Array.from({ length: 101 }, (_, index) => file('a', `item${index}.log`)),
    ];
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files });
    const first = await engine.execute(
      request({ operation: 'search', query: 'a', path: '', maxChars: 16000 }),
    );
    expect(first.coverage.skipped).toBe(1);
    const last = await engine.execute(
      request({
        operation: 'search',
        query: 'a',
        path: '',
        maxChars: 16000,
        cursor: first.nextCursor,
      }),
    );
    expect(last.nextCursor).toBeUndefined();
    expect(last.coverage.skipped).toBe(1);
    expect(last.coverage.complete).toBe(false);
  });

  it('reads a requested tail without claiming the earlier bytes were inspected', async () => {
    const engine = createFolderEngine({
      id: folderId,
      label: 'Logs',
      files: [file('prefix ä🙂 tail marker')],
    });
    const result = await engine.execute(request({ startByte: 10 }));
    expect(result.text).toBe(' tail marker');
    expect(result.source?.byteStart).toBe(13);
    expect(result.status).toBe('partial');
    expect(result.coverage.complete).toBe(false);
    expect(result.nextCursor).toBeUndefined();
    expect(result.coverage.reason).toContain('frühere');
  });

  it('requests a PDF page directly and reports the earlier pages as uninspected', async () => {
    jest.mocked(readPdf).mockResolvedValueOnce({
      text: 'page 900',
      page: 900,
      pagesTotal: 900,
      offset: 0,
      bytesRead: 123,
    });
    const engine = createFolderEngine({
      id: folderId,
      label: 'Docs',
      files: [file('pdf', 'large.pdf')],
    });
    const result = await engine.execute(request({ path: 'large.pdf', page: 900 }));
    expect(readPdf).toHaveBeenLastCalledWith(expect.anything(), 900, 0, expect.any(Number));
    expect(result.text).toBe('page 900');
    expect(result.status).toBe('partial');
    expect(result.coverage.complete).toBe(false);
  });

  it('keeps search hits after an unreadable document and reports skipped coverage', async () => {
    jest.mocked(readPdf).mockRejectedValueOnce(new Error('locked'));
    const engine = createFolderEngine({
      id: folderId,
      label: 'Docs',
      files: [
        file('ERROR first', 'first.log'),
        file('locked', 'locked.pdf'),
        file('ERROR second', 'last.log'),
      ],
    });
    const result = await engine.execute(request({ operation: 'search', query: 'error', path: '' }));
    expect(result.matches).toHaveLength(2);
    expect(result.coverage.skipped).toBe(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('does not count a word ending at a block boundary until its following boundary is known', async () => {
    const text = ' '.repeat(65531) + 'errorCode error warning';
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files: [file(text)] });
    const result = await engine.execute(request({ operation: 'inspect' }));
    expect(result.text).toContain('1 Vorkommen von error/fatal/exception, 1 von warn/warning');
  });

  it('refuses changed files and cursors reused for a different request', async () => {
    const source = file('large text\n'.repeat(1000));
    const files = [source];
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files });
    const first = await engine.execute(request());
    const wrong = await engine.execute(
      request({ operation: 'search', query: 'large', cursor: first.nextCursor }),
    );
    expect(wrong.status).toBe('error');
    files[0] = file('replacement');
    const changed = await engine.execute(request({ cursor: first.nextCursor }));
    expect(changed.status).toBe('error');
    expect(changed.message).toContain('verändert');
  });

  it.each(['../secret', '/etc/passwd', 'a/../b', 'a\\b', 'a//b', './a'])(
    'refuses path traversal %s',
    async (path) => {
      const engine = createFolderEngine({ id: folderId, label: 'Logs', files: [] });
      expect((await engine.execute(request({ path }))).status).toBe('error');
    },
  );

  it('paginates folder lists and reports unsupported formats honestly', async () => {
    const files = Array.from({ length: 200 }, (_, index) => file('', `file-${index}.txt`));
    files.push(file('binary', 'archive.zip'));
    const engine = createFolderEngine({ id: folderId, label: 'Logs', files });
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await engine.execute(
        request({ operation: 'list', path: '', cursor, maxChars: 2500 }),
      );
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2500);
      names.push(...(result.entries ?? []).map((entry) => entry.path));
      cursor = result.nextCursor;
    } while (cursor);
    expect(names).toHaveLength(201);
    expect(new Set(names).size).toBe(201);
    const unsupported = await engine.execute(request({ path: 'archive.zip' }));
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.coverage.complete).toBe(false);
  });

  it('refuses revoked permissions without requesting a new grant', async () => {
    const handle = {
      queryPermission: jest.fn().mockResolvedValue('denied'),
      getDirectoryHandle: jest.fn(),
    } as unknown as FileSystemDirectoryHandle;
    const engine = createFolderEngine({ id: folderId, label: 'Logs', handle });
    expect((await engine.execute(request())).status).toBe('unavailable');
    expect(handle.getDirectoryHandle).not.toHaveBeenCalled();
  });
});
