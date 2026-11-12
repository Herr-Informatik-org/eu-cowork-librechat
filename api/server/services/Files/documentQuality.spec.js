jest.mock('@librechat/api', () => ({
  DOCUMENT_TOOL_NAME: 'generate_document',
  documentToolDefinition: { description: 'Geprüfte Dokumente' },
  HOST_FILE_AUTHORING_ARTIFACT_KEY: '__librechat_file_authoring',
}));
jest.mock('@librechat/agents/langchain/tools', () => ({
  tool: (func, options) => ({ ...options, func, invoke: func }),
}));
jest.mock('./Code/crud', () => ({
  uploadCodeEnvFile: jest.fn(async () => ({
    storage_session_id: 'private-session',
    file_id: 'private-file',
  })),
}));
const {
  governedFormat,
  assertDocumentQuality,
  createDocumentTool,
  guardBashDocumentOutputs,
} = require('./documentQuality');
const { uploadCodeEnvFile } = require('./Code/crud');

describe('mandatory document release policy', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.KISUNO_DOCUMENTS_ENABLED = 'true';
    global.fetch = jest.fn();
  });
  afterEach(() => {
    delete process.env.KISUNO_DOCUMENTS_ENABLED;
    global.fetch = originalFetch;
  });
  it('detects renamed PDF and Office files', () => {
    expect(governedFormat('renamed.txt', Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(governedFormat('data.bin', Buffer.from('PK anything word/document.xml'))).toBe('docx');
    expect(governedFormat('chart.png', Buffer.from('PNG'))).toBeNull();
  });
  it('never falls back when the checker is unreachable', async () => {
    global.fetch.mockRejectedValue(Error('network'));
    await expect(
      assertDocumentQuality('renamed.txt', Buffer.from('%PDF-1.7')),
    ).rejects.toMatchObject({ code: 'DOCUMENT_QUALITY_BLOCKED' });
  });
  it('rejects a negative release decision', async () => {
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Kontrast zu klein' }), { status: 422 }),
    );
    await expect(assertDocumentQuality('report.pdf', Buffer.from('%PDF-1.7'))).rejects.toThrow(
      'Kontrast',
    );
  });
  it('requires a generated document but leaves ordinary code output available', async () => {
    const bash = {
      func: async () => [
        '42',
        {
          files: [
            { name: 'unsafe.pdf' },
            { name: 'result.csv' },
            { name: 'input.docx', inherited: true },
          ],
        },
      ],
    };
    const result = await guardBashDocumentOutputs(bash).func();
    expect(result[0]).toContain('generate_document');
    expect(result[1].files.map((file) => file.name)).toEqual(['result.csv', 'input.docx']);
  });
  it('uses default branding and user-private storage', async () => {
    const report = {
      format: 'pdf',
      filename: 'bericht.pdf',
      pages: 1,
      minimumContrast: 13.13,
      logoApplied: true,
    };
    global.fetch.mockResolvedValue(
      new Response(Buffer.from('%PDF-checked'), {
        status: 200,
        headers: {
          'x-kisuno-document-report': Buffer.from(JSON.stringify(report)).toString('base64'),
        },
      }),
    );
    const req = { user: { id: 'user-1', tenantId: 'tenant-a' } };
    const result = await createDocumentTool(req).invoke({
      format: 'pdf',
      filename: 'bericht.pdf',
      document: JSON.stringify({
        title: 'Bericht',
        branding: 'none',
        blocks: [{ type: 'paragraph', text: 'Daten' }],
      }),
    });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body.toString()).branding).toBe('default');
    expect(uploadCodeEnvFile).toHaveBeenCalledWith(
      expect.objectContaining({ req, id: 'user-1', kind: 'user', filename: 'bericht.pdf' }),
    );
    expect(result[1].__librechat_file_authoring).toBe(true);
    expect(result[1].files[0].storage_session_id).toBe('private-session');
  });
  it('honours explicit logo opt-out and does not upload a failed result', async () => {
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Berechnung falsch' }), { status: 422 }),
    );
    uploadCodeEnvFile.mockClear();
    const result = await createDocumentTool({ user: { id: 'user-1' } }).invoke({
      format: 'pdf',
      filename: 'bericht.pdf',
      include_logo: false,
      document: '{"title":"Test"}',
    });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body.toString()).branding).toBe('none');
    expect(result[0]).toContain('nicht freigegeben');
    expect(uploadCodeEnvFile).not.toHaveBeenCalled();
  });
});

describe('document repair limit', () => {
  it('allows one attempt and two repairs, then stops the same file in the same request', async () => {
    const originalFetch = global.fetch;
    process.env.KISUNO_DOCUMENTS_ENABLED = 'true';
    global.fetch = jest.fn(
      async () => new Response('{"error":"Prüfung fehlgeschlagen"}', { status: 422 }),
    );
    try {
      const req = { user: { id: 'repair-user' } };
      const input = { format: 'pdf', filename: 'bericht.pdf', document: '{"title":"Test"}' };
      for (let i = 0; i < 3; i++) await createDocumentTool(req).invoke(input);
      const result = await createDocumentTool(req).invoke(input);
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(result[0]).toContain('Drei Versuche');
    } finally {
      global.fetch = originalFetch;
      delete process.env.KISUNO_DOCUMENTS_ENABLED;
    }
  });
});
