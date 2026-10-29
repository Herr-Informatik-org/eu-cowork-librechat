import {
  assertScannableAttachment,
  attachmentDownloadName,
  checkAttachmentBytes,
  readAttachmentBytes,
} from './attachments';
import { MAX_SCANNED_ATTACHMENT_BYTES, MailAttachmentScanError } from './scanner';
import sharp from 'sharp';

const verdict = {
  verdict: 'no_known_threats' as const,
  engine: 'ClamAV' as const,
  scannedAt: '2026-10-29T10:00:00Z',
  signaturesAt: '2026-10-29T09:00:00Z',
};
const text = Buffer.from('Grüezi\nKeine automatische Ausführung.');
const file = { name: 'Notiz.txt', contentType: 'text/plain', size: text.length };

describe('attachment release boundary', () => {
  test('scans and returns the exact same fully validated bytes', async () => {
    const scan = jest.fn(async () => verdict);
    const result = await checkAttachmentBytes(file, text, scan);
    expect(scan).toHaveBeenCalledWith(text);
    expect(result.bytes).toBe(text);
    expect(result.scan).toBe(verdict);
  });
  test.each([
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['archive.zip', 'application/zip'],
    ['run.exe', 'application/octet-stream'],
    ['picture.svg', 'image/svg+xml'],
    ['page.html', 'text/html'],
    ['pdf', 'application/pdf'],
    ['picture.png', 'text/plain'],
    ['note.txt.exe', 'text/plain'],
    ['.pdf', 'application/pdf'],
  ])('rejects unsupported or inconsistent %s before scanning', async (name, contentType) => {
    const scan = jest.fn(async () => verdict);
    await expect(checkAttachmentBytes({ ...file, name, contentType }, text, scan)).rejects.toThrow(
      'gesperrt',
    );
    expect(scan).not.toHaveBeenCalled();
  });
  test.each([0, -1, 2.5, MAX_SCANNED_ATTACHMENT_BYTES + 1])('rejects invalid size %s', (size) => {
    expect(() => assertScannableAttachment({ ...file, size })).toThrow();
  });
  test.each([
    ['fake.pdf', 'application/pdf', Buffer.from('<html>fake</html>')],
    ['fake.png', 'image/png', text],
    ['fake.jpg', 'image/jpeg', text],
    ['fake.txt', 'text/plain', Buffer.from([0, 1, 2])],
    ['fake.txt', 'text/plain', Buffer.from([0xc0, 0xaf])],
    ['incomplete.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nMissing trailer')],
  ])('rejects mismatched or truncated bytes for %s', async (name, contentType, bytes) => {
    const scan = jest.fn(async () => verdict);
    await expect(
      checkAttachmentBytes({ name, contentType, size: bytes.length }, bytes, scan),
    ).rejects.toThrow('stimmen nicht überein');
    expect(scan).not.toHaveBeenCalled();
  });
  test('accepts raster magic only after scanner verdict', async () => {
    for (const format of ['png', 'jpeg'] as const) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
        [format]()
        .toBuffer();
      await expect(
        checkAttachmentBytes(
          { name: `bild.${format}`, contentType: `image/${format}`, size: bytes.length },
          bytes,
          async () => verdict,
        ),
      ).resolves.toMatchObject({ bytes });
    }
    const bytes = Buffer.from('%PDF-1.7\nExample fixture\n%%EOF\n');
    await expect(
      checkAttachmentBytes(
        { name: 'test.pdf', contentType: 'application/pdf', size: bytes.length },
        bytes,
        async () => verdict,
      ),
    ).resolves.toMatchObject({ bytes });
  });
  test('does not release bytes on any scanner failure', async () => {
    await expect(
      checkAttachmentBytes(file, text, async () => {
        throw new MailAttachmentScanError('found');
      }),
    ).rejects.toThrow();
  });
  test('sanitizes filename path, headers and bidi without adding executable extensions', () => {
    expect(attachmentDownloadName('../a\r\n/evil\u202e.txt')).toBe('_a___evil_.txt');
    expect(attachmentDownloadName('a'.repeat(250) + '.pdf')).toBe('a'.repeat(160) + '.pdf');
  });
  test('reads bounded complete bytes and checks authorization while streaming', async () => {
    const guard = jest.fn(async () => {});
    const bytes = await readAttachmentBytes(new Response(new Uint8Array(text)), text.length, guard);
    expect(bytes).toEqual(text);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  test.each([text.length - 1, text.length + 1])(
    'rejects incorrect actual length %s',
    async (size) => {
      await expect(
        readAttachmentBytes(new Response(new Uint8Array(text)), size, async () => {}),
      ).rejects.toThrow();
    },
  );
  test('rejects declared length mismatch and authorization revocation', async () => {
    await expect(
      readAttachmentBytes(
        new Response(new Uint8Array(text), { headers: { 'Content-Length': '1' } }),
        text.length,
        async () => {},
      ),
    ).rejects.toThrow();
    await expect(
      readAttachmentBytes(new Response(new Uint8Array(text)), text.length, async () => {
        throw Error('revoked');
      }),
    ).rejects.toThrow('revoked');
  });
});
