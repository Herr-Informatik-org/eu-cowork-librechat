import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildOfficePdfReference,
  officePdfKey,
  parseOfficePdfReference,
  prepareOfficePdf,
  readOfficePdf,
  OFFICE_PDF_MAX_BYTES,
} from './officePdf';

describe('private Office PDF cache', () => {
  const originalFetch = global.fetch;
  let directory: string;
  const input = Buffer.from('original office fixture');
  const pdf = Buffer.from('%PDF-1.7\nfixture');
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'office-pdf-test-'));
    process.env.OFFICE_PREVIEW_CACHE_DIR = directory;
    process.env.OFFICE_PREVIEW_RENDERER_URL = 'http://office-preview:8090';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(pdf);
          controller.close();
        },
      }),
    });
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.OFFICE_PREVIEW_CACHE_DIR;
    delete process.env.OFFICE_PREVIEW_RENDERER_URL;
    await rm(directory, { recursive: true, force: true });
  });
  it('stores PDF outside Mongo and returns a small bounded reference without changing the original', async () => {
    const original = Buffer.from(input);
    const html = await buildOfficePdfReference(input, 'xlsx');
    const reference = parseOfficePdfReference(html)!;
    expect(reference).toEqual({ key: officePdfKey(input, 'xlsx'), format: 'xlsx' });
    expect(html.length).toBeLessThan(500);
    expect(html).not.toContain(pdf.toString('base64'));
    expect(await readOfficePdf(reference.key)).toEqual(pdf);
    expect(input).toEqual(original);
    expect(await readdir(directory)).toEqual([`${reference.key}.pdf`]);
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('http://office-preview:8090/render?format=xlsx'),
      expect.objectContaining({ redirect: 'error', method: 'POST' }),
    );
  });
  it('deduplicates concurrent renders and reuses the existing cache', async () => {
    const keys = await Promise.all([
      prepareOfficePdf(input, 'docx'),
      prepareOfficePdf(input, 'docx'),
    ]);
    expect(keys[0]).toBe(keys[1]);
    await prepareOfficePdf(input, 'docx');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects paths, arbitrary formats and oversized inputs before making a request', async () => {
    expect(await readOfficePdf('../../etc/passwd')).toBeNull();
    expect(
      parseOfficePdfReference('<meta name="librechat-office-pdf" content="../../etc/passwd:docx">'),
    ).toBeNull();
    await expect(prepareOfficePdf(input, 'html')).rejects.toThrow();
    await expect(
      prepareOfficePdf(Buffer.alloc(OFFICE_PDF_MAX_BYTES + 1), 'xlsx'),
    ).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('rejects non-PDF responses without caching them', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('<html>'));
          controller.close();
        },
      }),
    });
    await expect(prepareOfficePdf(input, 'docx')).rejects.toThrow('kein PDF');
    expect(await readdir(directory)).toEqual([]);
  });
  it('expires only its own disposable PDF cache', async () => {
    const key = await prepareOfficePdf(input, 'pptx');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(join(directory, `${key}.pdf`), old, old);
    expect(await readOfficePdf(key)).toBeNull();
    await expect(readFile(join(directory, `${key}.pdf`))).rejects.toThrow();
  });
  it('removes only stale temporary writes left by a crashed renderer', async () => {
    const orphan = `${'a'.repeat(64)}-12345678-1234-1234-1234-123456789abc.tmp`;
    await writeFile(join(directory, orphan), 'incomplete');
    await writeFile(join(directory, 'unrelated.txt'), 'preserve');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(directory, orphan), old, old);
    await prepareOfficePdf(input, 'docx');
    expect(await readdir(directory)).not.toContain(orphan);
    expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe('preserve');
  });
});
