/**
 * Coverage for the new GET /files/:file_id/preview endpoint.
 *
 * Deferred-preview code-execution flow: the immediate persist step
 * emits a file record at `status: 'pending'`; the background render
 * transitions it to `'ready'` (with text) or `'failed'` (with
 * previewError). The frontend polls this endpoint until status is
 * terminal. This suite asserts the response shape across all four
 * states (pending, ready, failed, legacy/back-compat) and the auth
 * boundary (404 vs 403).
 */

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
  SystemCapabilities: {},
}));

jest.mock('@librechat/api', () => ({
  refreshS3FileUrls: jest.fn(),
  resolveUploadErrorMessage: jest.fn(),
  verifyAgentUploadPermission: jest.fn(),
  parseOfficePdfReference: jest.fn(),
  readOfficePdf: jest.fn(),
  prepareOfficePdf: jest.fn(),
  officePdfKey: jest.fn(),
  OFFICE_PDF_MAX_BYTES: 10 * 1024 * 1024,
}));

const mockFindFileById = jest.fn();
const mockGetFiles = jest.fn();
const mockUpdateFile = jest.fn();
const mockGetAgents = jest.fn().mockResolvedValue([]);
jest.mock('~/models', () => ({
  findFileById: (...args) => mockFindFileById(...args),
  getFiles: (...args) => mockGetFiles(...args),
  updateFile: (...args) => mockUpdateFile(...args),
  getAgents: (...args) => mockGetAgents(...args),
  batchUpdateFiles: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  processAgentFileUpload: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(() => (_req, _res, next) => next()),
  getEffectivePermissions: jest.fn().mockResolvedValue(0),
}));

jest.mock('~/server/services/Files', () => ({
  hasAccessToFilesViaAgent: jest.fn(),
}));

jest.mock('~/server/utils/files', () => ({
  cleanFileName: (name) => name,
  getContentDisposition: (name) => `attachment; filename="${name}"`,
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({ get: jest.fn(), set: jest.fn() })),
}));

const express = require('express');
const request = require('supertest');
const filesRouter = require('./files');
const officePdf = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

/**
 * Mount the router with a per-request user injector so we can simulate
 * a logged-in user without spinning up the full auth stack.
 */
function buildApp({ user = { id: 'user-123', role: 'user' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.config = { fileStrategy: 'local' };
    next();
  });
  app.use('/files', filesRouter);
  return app;
}

const OWNER_USER_ID = 'user-123';

describe('GET /files/:file_id/preview/pdf', () => {
  const key = 'a'.repeat(64);
  const file = {
    file_id: 'office-file',
    user: OWNER_USER_ID,
    source: 'local',
    filepath: '/uploads/example.xlsx',
    filename: 'example.xlsx',
    textFormat: 'html',
    text: 'reference',
    status: 'ready',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFiles.mockResolvedValue([file]);
    mockFindFileById.mockResolvedValue(file);
    officePdf.parseOfficePdfReference.mockImplementation((text) =>
      text === 'reference' ? { key, format: 'xlsx' } : null,
    );
    officePdf.readOfficePdf.mockResolvedValue(Buffer.from('%PDF-1.7\nfixture'));
    officePdf.officePdfKey.mockReturnValue(key);
    const { Readable } = require('stream');
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Readable.from([Buffer.from('original')]))),
    });
  });

  describe('workbook and original PDF views', () => {
    const originalFetch = global.fetch;
    beforeEach(() => {
      process.env.OFFICE_PREVIEW_RENDERER_URL = 'http://renderer:8090';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: require('stream').Readable.from([
          Buffer.from(JSON.stringify({ sheets: [{ name: 'Übersicht' }] })),
        ]),
      });
    });
    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.OFFICE_PREVIEW_RENDERER_URL;
    });
    it('uses only the authorized original and fixed renderer endpoint for workbook data', async () => {
      const response = await request(buildApp()).get('/files/office-file/preview/workbook');
      expect(response.status).toBe(200);
      expect(response.body.sheets[0].name).toBe('Übersicht');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(global.fetch.mock.calls[0][0].href).toBe(
        'http://renderer:8090/workbook?format=xlsx&sheet=0',
      );
      expect(global.fetch.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          body: Buffer.from('original'),
          redirect: 'error',
        }),
      );
      expect(mockUpdateFile).not.toHaveBeenCalled();
    });
    it('selects a bounded sheet and rejects invalid indices before renderer I/O', async () => {
      expect(
        (await request(buildApp()).get('/files/office-file/preview/workbook?sheet=9')).status,
      ).toBe(200);
      expect(global.fetch.mock.calls[0][0].search).toBe('?format=xlsx&sheet=9');
      global.fetch.mockClear();
      for (const index of ['-1', '20', '1.5', 'NaN']) {
        expect(
          (await request(buildApp()).get('/files/office-file/preview/workbook?sheet=' + index))
            .status,
        ).toBe(400);
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('denies workbook access to another user before renderer I/O', async () => {
      mockGetFiles.mockResolvedValue([{ ...file, user: 'other-user' }]);
      expect((await request(buildApp()).get('/files/office-file/preview/workbook')).status).toBe(
        403,
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('rejects a workbook changed while rendering', async () => {
      mockFindFileById
        .mockResolvedValueOnce(file)
        .mockResolvedValueOnce({ ...file, previewRevision: 'new' });
      expect((await request(buildApp()).get('/files/office-file/preview/workbook')).status).toBe(
        409,
      );
    });
    it('rejects malformed renderer output', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        body: require('stream').Readable.from([Buffer.from('{"sheets":[]}')]),
      });
      expect((await request(buildApp()).get('/files/office-file/preview/workbook')).status).toBe(
        503,
      );
    });
    it('serves an original PDF without conversion or changing bytes', async () => {
      const pdf = { ...file, filename: 'test.pdf', text: '' };
      mockFindFileById.mockResolvedValue(pdf);
      const bytes = Buffer.from('%PDF-1.7\noriginal');
      getStrategyFunctions.mockReturnValue({
        getDownloadStream: async () => require('stream').Readable.from([bytes]),
      });
      const response = await request(buildApp()).get('/files/office-file/preview/pdf');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(bytes);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(officePdf.prepareOfficePdf).not.toHaveBeenCalled();
    });
  });
  it('serves only the authorized file PDF with no shared cache', async () => {
    const res = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(officePdf.readOfficePdf).toHaveBeenCalledWith(key);
  });
  it('renders an authorized Office upload lazily without overwriting its extracted RAG text', async () => {
    const upload = {
      ...file,
      text: 'Original extracted document text',
      textFormat: 'text',
    };
    mockFindFileById.mockResolvedValue(upload);
    officePdf.readOfficePdf.mockResolvedValueOnce(null);
    const response = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(response.status).toBe(200);
    expect(officePdf.prepareOfficePdf).toHaveBeenCalledWith(Buffer.from('original'), 'xlsx');
    expect(mockUpdateFile).not.toHaveBeenCalled();
  });
  it('denies lazy previews of another user upload through the same fileAccess boundary', async () => {
    mockGetFiles.mockResolvedValue([
      { ...file, user: 'other-user', text: undefined, textFormat: undefined },
    ]);
    mockGetAgents.mockResolvedValue([]);
    const response = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(response.status).toBe(403);
    expect(officePdf.prepareOfficePdf).not.toHaveBeenCalled();
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });
  it('rejects a plaintext file containing a copied PDF descriptor before cache access', async () => {
    mockFindFileById.mockResolvedValue({
      ...file,
      filename: 'copied.txt',
      textFormat: 'text',
    });
    expect((await request(buildApp()).get('/files/office-file/preview/pdf')).status).toBe(404);
    expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
  });
  it('rejects an own Office file containing a foreign hash even when that PDF is cached', async () => {
    officePdf.officePdfKey.mockReturnValue('b'.repeat(64));
    expect((await request(buildApp()).get('/files/office-file/preview/pdf')).status).toBe(409);
    expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
    expect(officePdf.prepareOfficePdf).not.toHaveBeenCalled();
  });
  it('rejects additional requests before original I/O when both slots are occupied', async () => {
    const { Readable } = require('stream');
    let releaseReads;
    const blocked = new Promise((resolve) => {
      releaseReads = resolve;
    });
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    let reads = 0;
    const getDownloadStream = jest.fn(async () => {
      if (++reads === 2) {
        markStarted();
      }
      await blocked;
      return Readable.from([Buffer.from('original')]);
    });
    getStrategyFunctions.mockReturnValue({ getDownloadStream });
    const app = buildApp();
    const first = request(app)
      .get('/files/office-file/preview/pdf')
      .then((response) => response);
    const second = request(app)
      .get('/files/office-file/preview/pdf')
      .then((response) => response);
    await started;
    try {
      const third = await request(app).get('/files/office-file/preview/pdf');
      expect(third.status).toBe(503);
      expect(third.headers['retry-after']).toBe('2');
      expect(getDownloadStream).toHaveBeenCalledTimes(2);
      expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
    } finally {
      releaseReads();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
    }
  });
  it('rejects oversized original streams before hash calculation or cache access', async () => {
    const { Readable } = require('stream');
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)])),
    });
    const response = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(response.status).toBe(413);
    expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
  });
  it('denies another user before reading the cache', async () => {
    mockGetFiles.mockResolvedValue([{ ...file, user: 'another-user' }]);
    mockGetAgents.mockResolvedValue([]);
    const res = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(res.status).toBe(403);
    expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
  });
  it('rejects a deleted file before reading the cache', async () => {
    mockGetFiles.mockResolvedValue([]);
    const res = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(res.status).toBe(404);
    expect(officePdf.readOfficePdf).not.toHaveBeenCalled();
  });
  it('rejects a revision changed during rendering', async () => {
    mockFindFileById
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, text: 'new revision' });
    expect((await request(buildApp()).get('/files/office-file/preview/pdf')).status).toBe(409);
  });
  it('rebuilds a cache miss from authorized original storage without updating the original', async () => {
    const { Readable } = require('stream');
    const getDownloadStream = jest.fn().mockResolvedValue(Readable.from([Buffer.from('original')]));
    getStrategyFunctions.mockReturnValue({ getDownloadStream });
    officePdf.readOfficePdf.mockResolvedValueOnce(null);
    officePdf.officePdfKey.mockReturnValue(key);
    const res = await request(buildApp()).get('/files/office-file/preview/pdf');
    expect(res.status).toBe(200);
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), file.filepath);
    expect(officePdf.prepareOfficePdf).toHaveBeenCalledWith(Buffer.from('original'), 'xlsx');
    expect(mockUpdateFile).not.toHaveBeenCalled();
  });
  it('rejects a changed original rather than rendering stale metadata', async () => {
    const { Readable } = require('stream');
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('changed')])),
    });
    officePdf.officePdfKey.mockReturnValue('b'.repeat(64));
    expect((await request(buildApp()).get('/files/office-file/preview/pdf')).status).toBe(409);
    expect(officePdf.prepareOfficePdf).not.toHaveBeenCalled();
  });
});

describe('GET /files/:file_id/preview', () => {
  beforeEach(() => {
    mockFindFileById.mockReset();
    mockGetFiles.mockReset();
    mockUpdateFile.mockReset();
    mockGetAgents.mockReset();
    mockGetAgents.mockResolvedValue([]);
  });

  it('returns 404 when the file does not exist (auth check fails first via fileAccess)', async () => {
    /* `fileAccess` middleware does its own getFiles lookup and returns
     * 404 before our handler ever runs. This test asserts the boundary
     * lives there, not that the handler duplicates the check. */
    mockGetFiles.mockResolvedValueOnce([]);
    const res = await request(buildApp()).get('/files/missing-id/preview');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not Found' });
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('returns 403 when the requester does not own the file and has no agent-based access', async () => {
    /* fileAccess returns 403 — the file exists but belongs to someone
     * else and no agent grants access. The preview handler should
     * never run. */
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'someone-elses', user: 'other-user', filename: 'x.xlsx' },
    ]);
    const res = await request(buildApp()).get('/files/someone-elses/preview');
    expect(res.status).toBe(403);
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('allows preview text through an attached agent file reference', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'victim-file',
        user: 'victim-user',
        filename: 'secret.xlsx',
        status: 'ready',
      },
    ]);
    mockGetAgents.mockResolvedValueOnce([
      {
        id: 'agent-attacker',
        author: 'attacker-user',
        tool_resources: { execute_code: { file_ids: ['victim-file'] } },
      },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'victim-file',
      text: 'shared secret',
      textFormat: 'text',
    });

    const res = await request(buildApp({ user: { id: 'attacker-user', role: 'user' } })).get(
      '/files/victim-file/preview',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'victim-file',
      status: 'ready',
      text: 'shared secret',
      textFormat: 'text',
    });
  });

  it('returns status:pending without text/textFormat while the deferred render is in flight', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-pending',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'pending',
      },
    ]);
    const res = await request(buildApp()).get('/files/fid-pending/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-pending', status: 'pending' });
    /* Pending must NOT leak `text` and must NOT trigger the text re-fetch. */
    expect(res.body).not.toHaveProperty('text');
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('returns status:ready with text + textFormat when the deferred render succeeded', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-ready',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'ready',
      },
    ]);
    /* Text is fetched only on the terminal ready response. */
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-ready',
      text: '<table><tr><td>1</td></tr></table>',
      textFormat: 'html',
    });
    const res = await request(buildApp()).get('/files/fid-ready/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-ready',
      status: 'ready',
      text: '<table><tr><td>1</td></tr></table>',
      textFormat: 'html',
    });
  });

  it('returns status:failed with previewError when the deferred render errored', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-failed',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'failed',
        previewError: 'parser-error',
      },
    ]);
    const res = await request(buildApp()).get('/files/fid-failed/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-failed',
      status: 'failed',
      previewError: 'parser-error',
    });
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('defaults to status:ready for legacy records with no status field (back-compat)', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-legacy',
        user: OWNER_USER_ID,
        filename: 'old.csv',
        // status intentionally absent
      },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-legacy',
      text: 'csv,header\n1,2',
      textFormat: 'text',
    });
    const res = await request(buildApp()).get('/files/fid-legacy/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-legacy',
      status: 'ready',
      text: 'csv,header\n1,2',
      textFormat: 'text',
    });
  });

  it('returns status:ready with no text when the record is ready but text is null (binary/oversized)', async () => {
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'fid-binary', user: OWNER_USER_ID, filename: 'image.bin' },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-binary',
      text: null,
      textFormat: null,
    });
    const res = await request(buildApp()).get('/files/fid-binary/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-binary', status: 'ready' });
  });

  it('returns ready with no text when ready record was deleted between fileAccess and text fetch', async () => {
    /* `fileAccess` saw the record but the concurrent delete removed it
     * before the text fetch. Surface ready-without-text rather than
     * 500 — the client routes to download-only and stops polling. */
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-race',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'ready',
      },
    ]);
    mockFindFileById.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get('/files/fid-race/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-race', status: 'ready' });
  });

  it('returns 500 with a stable shape if the text fetch throws unexpectedly', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-boom',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'ready',
      },
    ]);
    mockFindFileById.mockRejectedValueOnce(new Error('mongo down'));
    const res = await request(buildApp()).get('/files/fid-boom/preview');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Internal Server Error' });
  });

  describe('lazy sweep for stale pending records', () => {
    /* The boot-time `sweepOrphanedPreviews` only runs once at startup
     * with a 5-min cutoff. A backend crash + quick restart can leave
     * `pending` records younger than 5 min that never get touched
     * again. This endpoint sweeps them on the spot whenever a polling
     * request lands on one — the user is exactly the consumer who
     * cares, so on-demand sweep is the right shape. (Codex P2 review
     * on PR #12957.) */
    const STALE_MS = 6 * 60 * 1000;
    const FRESH_MS = 30 * 1000;

    it('marks a stale pending record as failed:orphaned and returns the swept state', async () => {
      const updatedAt = new Date(Date.now() - STALE_MS);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-stale',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce({
        file_id: 'fid-stale',
        status: 'failed',
        previewError: 'orphaned',
      });

      const res = await request(buildApp()).get('/files/fid-stale/preview');

      expect(mockUpdateFile).toHaveBeenCalledWith(
        { file_id: 'fid-stale', status: 'failed', previewError: 'orphaned' },
        { status: 'pending', updatedAt },
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        file_id: 'fid-stale',
        status: 'failed',
        previewError: 'orphaned',
      });
    });

    it('does NOT sweep a fresh pending record (within the cutoff window)', async () => {
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-fresh',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt: new Date(Date.now() - FRESH_MS),
        },
      ]);

      const res = await request(buildApp()).get('/files/fid-fresh/preview');

      expect(mockUpdateFile).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ file_id: 'fid-fresh', status: 'pending' });
    });

    it('sweeps a record past the 2min cutoff but below the 5min boot-sweep threshold', async () => {
      /* Pins the cutoff change from 5min to 2min — without this, a
       * future revert wouldn't fail the suite. */
      const updatedAt = new Date(Date.now() - 3 * 60 * 1000);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-mid',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce({
        file_id: 'fid-mid',
        status: 'failed',
        previewError: 'orphaned',
      });

      const res = await request(buildApp()).get('/files/fid-mid/preview');

      expect(mockUpdateFile).toHaveBeenCalled();
      expect(res.body).toEqual({
        file_id: 'fid-mid',
        status: 'failed',
        previewError: 'orphaned',
      });
    });

    it('does NOT sweep a stale ready record (only pending qualifies)', async () => {
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-ready',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'ready',
          updatedAt: new Date(Date.now() - STALE_MS),
        },
      ]);
      mockFindFileById.mockResolvedValueOnce({
        file_id: 'fid-ready',
        text: 'final',
        textFormat: 'html',
      });

      const res = await request(buildApp()).get('/files/fid-ready/preview');

      expect(mockUpdateFile).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ status: 'ready', text: 'final' });
    });

    it('falls through to the original pending payload if the conditional sweep loses the race', async () => {
      const updatedAt = new Date(Date.now() - STALE_MS);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-race',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce(null);

      const res = await request(buildApp()).get('/files/fid-race/preview');

      expect(mockUpdateFile).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ file_id: 'fid-race', status: 'pending' });
    });
  });
});
