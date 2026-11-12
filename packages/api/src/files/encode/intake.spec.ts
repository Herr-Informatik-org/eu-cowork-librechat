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
    jest.spyOn(global, 'fetch').mockImplementation(
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
  it.each([Providers.OPENAI, Providers.ANTHROPIC, Providers.GOOGLE, Providers.BEDROCK])(
    'reads XLSX as local values and formulas for %s',
    async (provider) => {
      const spreadsheet = {
        ...file,
        filename: 'Kosten.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      (getFileStream as jest.Mock).mockResolvedValue({
        file: spreadsheet,
        metadata: spreadsheet,
        content: data.toString('base64'),
      });
      jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              format: 'xlsx',
              sha256: createHash('sha256').update(data).digest('hex'),
              binarySentToModel: false,
              sheets: [
                { name: 'Kosten', cells: [{ address: 'B4', formula: 'B2*B3', value: '1800' }] },
              ],
            }),
          ),
      );
      const result = await encodeAndFormatDocuments(req, [spreadsheet], { provider }, strategy);
      expect(result.documents[0].type).toBe('text');
      expect(JSON.stringify(result.documents)).toContain('B2*B3');
      expect(JSON.stringify(result.documents)).not.toContain(data.toString('base64'));
      expect(String(jest.mocked(global.fetch).mock.calls[0][0])).toContain('inspect-workbook');
    },
  );
  it('stops with an actionable error when the private original is unavailable', async () => {
    (getFileStream as jest.Mock).mockRejectedValueOnce(Error('storage unavailable'));
    await expect(
      encodeAndFormatDocuments(req, [file], { provider: Providers.OPENAI }, strategy),
    ).rejects.toThrow('Keine vollständige Vorlagenprüfung');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each([Providers.OPENAI, Providers.ANTHROPIC, Providers.GOOGLE, Providers.BEDROCK])(
    'PDF accounting data crosses %s only as local text',
    async (provider) => {
      const pdf = { ...file, filename: 'Konto.pdf', type: 'application/pdf' };
      (getFileStream as jest.Mock).mockResolvedValue({
        file: pdf,
        metadata: pdf,
        content: data.toString('base64'),
      });
      jest
        .mocked(global.fetch)
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              format: 'pdf',
              sha256: createHash('sha256').update(data).digest('hex'),
              binarySentToModel: false,
              pages: [{ page: 1, text: '6000 Miete Annegret Zwyssig 1800.00' }],
              complete: true,
            }),
          ),
        );
      const result = await encodeAndFormatDocuments(req, [pdf], { provider }, strategy);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].type).toBe('text');
      expect(JSON.stringify(result.documents)).toContain('1800.00');
      expect(JSON.stringify(result.documents)).not.toContain(data.toString('base64'));
      expect(JSON.stringify(result.documents)).not.toContain('file_data');
      expect(String(jest.mocked(global.fetch).mock.calls[0][0])).toContain(
        '/documents/inspect-pdf',
      );
    },
  );
  it.each(['renderer', 'storage', 'empty', 'hash', 'size'])(
    'keeps the chat available and omits unreadable PDF on %s failure',
    async (reason) => {
      const pdf = { ...file, filename: 'Konto.pdf', type: 'application/pdf' };
      (getFileStream as jest.Mock).mockResolvedValue({
        file: pdf,
        metadata: pdf,
        content: data.toString('base64'),
      });
      if (reason === 'renderer') jest.mocked(global.fetch).mockRejectedValue(Error('offline'));
      if (reason === 'storage') (getFileStream as jest.Mock).mockRejectedValue(Error('offline'));
      if (reason === 'empty') (getFileStream as jest.Mock).mockResolvedValue(null);
      if (reason === 'size') (getConfiguredFileSizeLimit as jest.Mock).mockReturnValue(1);
      const result = await encodeAndFormatDocuments(
        req,
        [pdf],
        { provider: Providers.OPENAI },
        strategy,
      );
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].type).toBe('text');
      expect(JSON.stringify(result.documents)).toContain('Dateihinweis');
      expect(JSON.stringify(result.documents)).toContain('Chat');
      expect(JSON.stringify(result.documents)).not.toContain(data.toString('base64'));
      expect(JSON.stringify(result.documents)).not.toContain('file_data');
    },
  );
  it('honours the configured file limit before invoking the renderer', async () => {
    (getConfiguredFileSizeLimit as jest.Mock).mockReturnValue(1);
    await expect(
      encodeAndFormatDocuments(req, [file], { provider: Providers.OPENAI }, strategy),
    ).rejects.toThrow('konfigurierte Dateigrösse');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
