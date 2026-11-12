import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { Providers } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { encodeAndFormatDocuments } from './document';
import { getFileStream, getConfiguredFileSizeLimit } from './utils';

jest.mock('./utils', () => ({ getFileStream: jest.fn(), getConfiguredFileSizeLimit: jest.fn() }));

describe('Word uploads cross the model boundary as locally inspected text', () => {
  const previousFetch = global.fetch;
  const data = Buffer.from('synthetic DOCX binary that must never reach the provider');
  const file = {
    file_id: 'private-file-id',
    filename: 'Vorlage.docx',
    filepath: '/private/reference',
    bytes: data.length,
    type: 'application/octet-stream',
    source: 'local',
    user: new Types.ObjectId(),
  } as IMongoFile;
  const req = { user: { id: file.user.toString() } } as ServerRequest;
  const strategy = jest.fn();
  beforeEach(() => {
    process.env.KISUNO_DOCUMENTS_ENABLED = 'true';
    jest.clearAllMocks();
    (getConfiguredFileSizeLimit as jest.Mock).mockReturnValue(undefined);
    (getFileStream as jest.Mock).mockResolvedValue({
      file,
      metadata: file,
      content: data.toString('base64'),
    });
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 'docx',
            sha256: createHash('sha256').update(data).digest('hex'),
            binarySentToModel: false,
            styles: [{ name: 'Normal', font: 'Noto Sans' }],
            textParts: [{ text: 'Synthetische Notiz' }],
          }),
        ),
    );
  });
  afterEach(() => {
    delete process.env.KISUNO_DOCUMENTS_ENABLED;
    global.fetch = previousFetch;
  });
  it.each([Providers.OPENAI, Providers.ANTHROPIC, Providers.GOOGLE, Providers.BEDROCK])(
    'sends no binary or document media block through %s',
    async (provider) => {
      const result = await encodeAndFormatDocuments(req, [file], { provider }, strategy);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].type).toBe('text');
      expect(JSON.stringify(result.documents)).toContain('private-file-id');
      expect(JSON.stringify(result.documents)).toContain('Synthetische Notiz');
      expect(JSON.stringify(result.documents)).not.toContain(data.toString('base64'));
      expect(JSON.stringify(result.documents)).not.toContain('file_data');
    },
  );
  it('stops with an actionable error when the private original is unavailable', async () => {
    (getFileStream as jest.Mock).mockRejectedValueOnce(Error('storage unavailable'));
    await expect(
      encodeAndFormatDocuments(req, [file], { provider: Providers.OPENAI }, strategy),
    ).rejects.toThrow('Keine vollständige Vorlagenprüfung');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('honours the configured file limit before invoking the renderer', async () => {
    (getConfiguredFileSizeLimit as jest.Mock).mockReturnValue(1);
    await expect(
      encodeAndFormatDocuments(req, [file], { provider: Providers.OPENAI }, strategy),
    ).rejects.toThrow('konfigurierte Dateigrösse');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
