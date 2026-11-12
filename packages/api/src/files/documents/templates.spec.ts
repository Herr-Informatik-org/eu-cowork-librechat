import { createHash } from 'crypto';
import { inspectWordTemplate, isWordTemplate } from './templates';

describe('private Word intake', () => {
  const previous = global.fetch;
  const data = Buffer.from('synthetic-docx');
  afterEach(() => {
    global.fetch = previous;
  });
  const response = (extra = {}) =>
    new Response(
      JSON.stringify({
        format: 'docx',
        sha256: createHash('sha256').update(data).digest('hex'),
        binarySentToModel: false,
        ...extra,
      }),
    );
  it('reads only through the configured local renderer and verifies the exact source', async () => {
    global.fetch = jest.fn(async () => response());
    expect(JSON.parse(await inspectWordTemplate(data)).binarySentToModel).toBe(false);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      '/documents/inspect-template',
    );
    expect(isWordTemplate('Vorlage.DOCX', 'application/octet-stream')).toBe(true);
  });
  it('never falls back to binary provider input when inspection fails', async () => {
    global.fetch = jest.fn(async () => {
      throw Error('offline');
    });
    await expect(inspectWordTemplate(data)).rejects.toThrow('keine ungeprüften Originaldateien');
  });
  it('rejects mismatching and oversized inspection responses', async () => {
    global.fetch = jest.fn(async () => response({ sha256: 'different' }));
    await expect(inspectWordTemplate(data)).rejects.toThrow('stimmen nicht');
    global.fetch = jest.fn(async () => new Response('x'.repeat(512 * 1024 + 1)));
    await expect(inspectWordTemplate(data)).rejects.toThrow('umfangreich');
  });
});
