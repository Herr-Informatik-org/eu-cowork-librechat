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
    jest.spyOn(global, 'fetch').mockImplementation(async () => response());
    expect(JSON.parse(await inspectWordTemplate(data)).binarySentToModel).toBe(false);
    expect(String(jest.mocked(global.fetch).mock.calls[0][0])).toContain(
      '/documents/inspect-template',
    );
    expect(isWordTemplate('Vorlage.DOCX', 'application/octet-stream')).toBe(true);
  });
  it('never falls back to binary provider input when inspection fails', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      throw Error('offline');
    });
    await expect(inspectWordTemplate(data)).rejects.toThrow('keine ungeprüften Originaldateien');
  });
  it('rejects mismatching and oversized inspection responses', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => response({ sha256: 'different' }));
    await expect(inspectWordTemplate(data)).rejects.toThrow('stimmen nicht');
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('x'.repeat(512 * 1024 + 1)));
    await expect(inspectWordTemplate(data)).rejects.toThrow('umfangreich');
  });
});
