import { File as NodeFile } from 'node:buffer';
import { crc32, deflateRawSync } from 'node:zlib';
import { DecompressionStream } from 'node:stream/web';
import { readDocx, readPdf } from './documents';

interface PdfRange {
  requestDataRange(begin: number, end: number): void;
  onDataRange: jest.Mock;
}
interface PdfOptions {
  range: PdfRange;
  disableAutoFetch: boolean;
  disableStream: boolean;
}
interface TextItem {
  str?: string;
  hasEOL?: boolean;
}
const mockGetDocument = jest.fn();
jest.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => 'local-pdf-worker.mjs', {
  virtual: true,
});
jest.mock('pdfjs-dist', () => ({
  getDocument: (options: PdfOptions) => mockGetDocument(options),
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {
    onDataRange = jest.fn();
  },
  PDFWorker: class {
    static create() {
      return new this();
    }

    destroy = jest.fn();
  },
}));

const workerTerminations: jest.Mock[] = [];
beforeAll(() => {
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    value: DecompressionStream,
  });
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      terminate = jest.fn();
      constructor() {
        workerTerminations.push(this.terminate);
      }
    },
  });
});
afterEach(() => {
  if (workerTerminations.splice(0).some((terminate) => terminate.mock.calls.length !== 1))
    throw new Error('PDF-Unterworker wurde nicht genau einmal beendet.');
});
beforeEach(() => mockGetDocument.mockReset());

const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const word = (text: string, prefix = 'w') =>
  `<${prefix}:document xmlns:${prefix}="${namespace}"><${prefix}:body><${prefix}:p><${prefix}:r>${text}</${prefix}:r></${prefix}:p></${prefix}:body></${prefix}:document>`;
interface ZipOptions {
  method?: number;
  flags?: number;
  expanded?: number;
  checksum?: number;
  localName?: string;
  name?: string;
}
function zip(
  entries: Array<{ body: Buffer; options?: ZipOptions }>,
  comment = Buffer.alloc(0),
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let position = 0;
  for (const { body, options = {} } of entries) {
    const name = Buffer.from(options.name ?? 'word/document.xml');
    const localName = Buffer.from(options.localName ?? name.toString());
    const method = options.method ?? 8;
    const data = method === 8 ? deflateRawSync(body) : body;
    const flags = options.flags ?? 0;
    const checksum = options.checksum ?? crc32(body);
    const expanded = options.expanded ?? body.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(flags & 8 ? 0 : checksum, 14);
    header.writeUInt32LE(flags & 8 ? 0 : data.length, 18);
    header.writeUInt32LE(flags & 8 ? 0 : expanded, 22);
    header.writeUInt16LE(localName.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(expanded, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(position, 42);
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(expanded, 12);
    }
    locals.push(header, localName, data, descriptor);
    central.push(directory, name);
    position += header.length + localName.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(position, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}
function file(bytes: Buffer, name = 'fixture.docx'): File {
  const native = new NodeFile([bytes], name, { lastModified: 0 });
  const browser = new File([], name, { lastModified: 0 });
  Object.defineProperties(browser, {
    size: { get: () => native.size },
    slice: {
      value: (start?: number, end?: number) => native.slice(start, end),
      configurable: true,
      writable: true,
    },
    stream: { value: () => native.stream() },
    arrayBuffer: { value: () => native.arrayBuffer() },
  });
  return browser;
}
function docx(xml: string, options?: ZipOptions): File {
  return file(zip([{ body: Buffer.from(xml), options }]));
}
function pdf(chunks: TextItem[][], pages = 1) {
  const tasks: Array<{ destroy: jest.Mock; page: { cleanup: jest.Mock }; cancel: jest.Mock }> = [];
  mockGetDocument.mockImplementation(() => {
    let index = 0;
    const cancel = jest.fn().mockResolvedValue(undefined);
    const reader = {
      read: jest.fn(async () =>
        index < chunks.length ? { done: false, value: { items: chunks[index++] } } : { done: true },
      ),
      cancel,
    };
    const page = { streamTextContent: () => ({ getReader: () => reader }), cleanup: jest.fn() };
    const task = {
      promise: Promise.resolve({ numPages: pages, getPage: jest.fn().mockResolvedValue(page) }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    tasks.push({ destroy: task.destroy, page, cancel });
    return task;
  });
  return tasks;
}

it.each([0, 8])('reads a real DOCX ZIP using compression method %s', async (method) => {
  const result = await readDocx(
    docx(word('<w:t>Grüsse &amp; &lt;A&gt; &#x1F642;</w:t><w:tab/><w:t>Ende</w:t><w:br/>'), {
      method,
    }),
    0,
    100,
  );
  expect(result.text).toBe('Grüsse & <A> 🙂\tEnde\n\n');
  expect(result.nextOffset).toBeUndefined();
  expect(result.bytesRead).toBeGreaterThan(0);
});

it('continues dense DOCX without losing text or splitting surrogate pairs', async () => {
  const expected = '1234🙂A🦊B'.repeat(50) + '\n';
  const input = docx(word(`<w:t>${expected.slice(0, -1)}</w:t>`));
  let offset = 0;
  let output = '';
  for (let count = 0; count < 500; count++) {
    const part = await readDocx(input, offset, 5);
    expect(part.text.length).toBeLessThanOrEqual(5);
    expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    output += part.text;
    if (part.nextOffset === undefined) break;
    expect(part.nextOffset).toBeGreaterThan(offset);
    offset = part.nextOffset;
  }
  expect(output).toBe(expected);
});

it('handles namespace aliases, default namespace, CDATA and ignorable comments', async () => {
  const aliased = word('<q:t><![CDATA[A < B & C]]><!-- <q:t>injected</q:t> --> &amp; D</q:t>', 'q');
  expect((await readDocx(docx(aliased), 0, 100)).text).toBe('A < B & C & D\n');
  const plain = `<document xmlns="${namespace}"><body><p><r><t>Text</t></r></p></body></document>`;
  expect((await readDocx(docx(plain), 0, 100)).text).toBe('Text\n');
});

it('ignores text from other namespaces and restores a scoped namespace declaration', async () => {
  const content =
    '<w:t>before</w:t><w:r xmlns:w="urn:other"><w:t>hidden</w:t></w:r><w:t>after</w:t>';
  expect((await readDocx(docx(word(content)), 0, 100)).text).toBe('beforeafter\n');
});

it.each(['utf-16le', 'utf-16be'])('decodes valid %s main bodies with BOM', async (encoding) => {
  let body = Buffer.from('\ufeff' + word('<w:t>Ä🙂Ω</w:t>'), 'utf16le');
  if (encoding === 'utf-16be') body = body.swap16();
  expect((await readDocx(file(zip([{ body }])), 0, 100)).text).toBe('Ä🙂Ω\n');
});

it('supports data descriptors and ignores fake EOCD markers in ZIP comments', async () => {
  const comment = Buffer.alloc(35);
  comment.writeUInt32LE(0x06054b50, 0);
  const input = file(
    zip([{ body: Buffer.from(word('<w:t>Text</w:t>')), options: { flags: 8 } }], comment),
  );
  expect((await readDocx(input, 0, 100)).text).toBe('Text\n');
});

it('does not inflate an unrelated ZIP entry even when its compression is unsupported', async () => {
  const input = file(
    zip([
      {
        body: Buffer.alloc(100_000, 255),
        options: { name: 'word/media/image1.bin', method: 99, flags: 1 },
      },
      { body: Buffer.from(word('<w:t>Only body</w:t>')) },
    ]),
  );
  const result = await readDocx(input, 0, 100);
  expect(result.text).toBe('Only body\n');
  expect(result.bytesRead).toBeLessThan(input.size);
});

it.each([
  { checksum: 1 },
  { expanded: 1 },
  { expanded: 33 * 1024 * 1024 },
  { flags: 1 },
  { method: 99 },
  { localName: 'word/another.xml' },
])('rejects damaged or unsupported ZIP body %j', async (options) => {
  await expect(readDocx(docx(word('<w:t>Text</w:t>'), options), 0, 100)).rejects.toThrow();
});

it('rejects duplicate bodies and incomplete directories', async () => {
  const body = Buffer.from(word('<w:t>Text</w:t>'));
  await expect(readDocx(file(zip([{ body }, { body }])), 0, 100)).rejects.toThrow(
    'mehrere Haupttexte',
  );
  const archive = zip([{ body }]);
  await expect(readDocx(file(archive.subarray(0, archive.length - 1)), 0, 100)).rejects.toThrow();
  archive.writeUInt16LE(2, archive.length - 14);
  archive.writeUInt16LE(2, archive.length - 12);
  await expect(readDocx(file(archive), 0, 100)).rejects.toThrow('Verzeichnis');
});

it.each([
  word('<w:t>broken</w:r>'),
  '<!DOCTYPE document [<!ENTITY leak SYSTEM "https://example.invalid/secret">]>' +
    word('<w:t>&leak;</w:t>'),
  word('<w:t>&unknown;</w:t>'),
  word('<w:t>&#xD800;</w:t>'),
  word('<w:t>&#0;</w:t>'),
  '<document><body><t>Other XML</t></body></document>',
])('refuses malformed XML, external entities and invalid character references', async (xml) => {
  await expect(readDocx(docx(xml), 0, 100)).rejects.toThrow();
});

it('rejects invalid UTF-8 instead of returning replacement text', async () => {
  const body = Buffer.concat([Buffer.from(word('<w:t>prefix')), Buffer.from([255])]);
  await expect(readDocx(file(zip([{ body }])), 0, 100)).rejects.toThrow();
});

it('rejects excessive XML nesting before returning an apparently complete body', async () => {
  const xml = word('<w:r>'.repeat(300) + '<w:t>Text</w:t>' + '</w:r>'.repeat(300));
  await expect(readDocx(docx(xml), 0, 100)).rejects.toThrow('verschachtelt');
});

it('continues PDF inside one large text item without gaps or surrogate fragments', async () => {
  const expected = '1234🙂A'.repeat(30) + ' \n';
  const tasks = pdf([[{ str: expected.slice(0, -2) }, { str: '', hasEOL: true }]]);
  let offset = 0;
  let output = '';
  for (let count = 0; count < 200; count++) {
    const part = await readPdf(file(Buffer.from('pdf'), 'fixture.pdf'), 1, offset, 5);
    expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    output += part.text;
    if (part.nextOffset === undefined) break;
    expect(part.nextOffset).toBeGreaterThan(offset);
    offset = part.nextOffset;
  }
  expect(output).toBe(expected);
  for (const task of tasks) {
    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(task.page.cleanup).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  }
});

it('ignores PDF marked-content metadata and advances to the next page explicitly', async () => {
  pdf([[{}, { str: 'First', hasEOL: true }, {}]], 2);
  const result = await readPdf(file(Buffer.from('pdf')), 1, 0, 100);
  expect(result).toMatchObject({
    text: 'First\n',
    page: 1,
    pagesTotal: 2,
    nextPage: 2,
    nextOffset: 0,
  });
});

it('releases PDF resources on invalid pages and stream failures', async () => {
  const tasks = pdf([]);
  await expect(readPdf(file(Buffer.from('pdf')), 2, 0, 100)).rejects.toThrow('Seite');
  expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  const cancel = jest.fn().mockResolvedValue(undefined);
  const cleanup = jest.fn();
  const destroy = jest.fn().mockResolvedValue(undefined);
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        cleanup,
        streamTextContent: () => ({
          getReader: () => ({
            cancel,
            read: async () => {
              throw new Error('stream failed');
            },
          }),
        }),
      }),
    }),
    destroy,
  });
  await expect(readPdf(file(Buffer.from('pdf')), 1, 0, 100)).rejects.toThrow('stream failed');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledTimes(1);
});

it('settles a rejected PDF byte range even if the parser promise never settles', async () => {
  const destroy = jest.fn().mockResolvedValue(undefined);
  mockGetDocument.mockImplementation((options: PdfOptions) => {
    queueMicrotask(() => options.range.requestDataRange(0, 33 * 1024 * 1024));
    return { promise: new Promise(() => undefined), destroy };
  });
  await expect(readPdf(file(Buffer.alloc(33 * 1024 * 1024)), 1, 0, 100)).rejects.toThrow('32 MiB');
  expect(destroy).toHaveBeenCalledTimes(1);
});

it('counts PDF bytes and disables automatic fetching and streaming', async () => {
  const tasks = pdf([[{ str: 'Text' }]]);
  const original = mockGetDocument.getMockImplementation();
  mockGetDocument.mockImplementation((options: PdfOptions) => {
    options.range.requestDataRange(0, 3);
    return original?.(options);
  });
  const result = await readPdf(file(Buffer.from('pdf')), 1, 0, 100);
  expect(result.bytesRead).toBe(3);
  expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  const options = mockGetDocument.mock.calls[0][0] as PdfOptions;
  expect(options).toMatchObject({ disableAutoFetch: true, disableStream: true });
});

it.each([
  [-1, 100],
  [0, 1],
  [0, NaN],
  [0, 17000],
])('rejects invalid section arguments %j %j before parsing', async (offset, maxChars) => {
  await expect(readDocx(docx(word('<w:t>Text</w:t>')), offset, maxChars)).rejects.toThrow(
    'Dokumentabschnitt',
  );
  await expect(readPdf(file(Buffer.from('pdf')), 1, offset, maxChars)).rejects.toThrow(
    'Dokumentabschnitt',
  );
  expect(mockGetDocument).not.toHaveBeenCalled();
});

it('caches only the last File identity and never collides on equal names and metadata', async () => {
  const first = docx(word('<w:t>First body</w:t>'));
  const second = docx(word('<w:t>Other body</w:t>'));
  const firstReads = jest.spyOn(first, 'slice');
  await readDocx(first, 0, 5);
  const count = firstReads.mock.calls.length;
  const cached = await readDocx(first, 5, 100);
  expect(cached).toMatchObject({ text: ' body\n', bytesRead: 0 });
  expect(firstReads).toHaveBeenCalledTimes(count);
  expect((await readDocx(second, 0, 100)).text).toBe('Other body\n');
  expect((await readDocx(first, 0, 100)).text).toBe('First body\n');
  expect(firstReads.mock.calls.length).toBeGreaterThan(count);
});

it('bounds the retained DOCX text to 32 MiB of UTF-16 code units', async () => {
  const input = docx(word('<w:t>' + 'a'.repeat(16 * 1024 * 1024) + '</w:t>'));
  await expect(readDocx(input, 0, 100)).rejects.toThrow('Zwischenspeicher');
}, 30000);

it('rejects password-protected PDFs without waiting for an unresolved parser', async () => {
  const task = {
    onPassword: () => undefined,
    promise: new Promise(() => undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
  mockGetDocument.mockImplementation(() => {
    queueMicrotask(() => task.onPassword());
    return task;
  });
  await expect(readPdf(file(Buffer.from('pdf')), 1, 0, 100)).rejects.toThrow(
    'Passwortgeschützte PDF',
  );
  expect(task.destroy).toHaveBeenCalledTimes(1);
});

it('ignores a delayed byte-range read after the PDF task is disposed', async () => {
  pdf([[{ str: 'Text' }]]);
  const input = file(Buffer.from('pdf'));
  const slice = input.slice(0, 3);
  let deliver: (value: ArrayBuffer) => void = () => undefined;
  jest.spyOn(slice, 'arrayBuffer').mockImplementation(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  jest.spyOn(input, 'slice').mockReturnValue(slice);
  const original = mockGetDocument.getMockImplementation();
  mockGetDocument.mockImplementation((options: PdfOptions) => {
    options.range.requestDataRange(0, 3);
    return original?.(options);
  });
  await readPdf(input, 1, 0, 100);
  deliver(new ArrayBuffer(3));
  await Promise.resolve();
  const options = mockGetDocument.mock.calls[0][0] as PdfOptions;
  expect(options.range.onDataRange).not.toHaveBeenCalled();
});
