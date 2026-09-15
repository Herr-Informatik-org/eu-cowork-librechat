import { classifyBrainFailure, createBrainFailureReporter } from './diagnostics';
import { BrainServiceError, requestBrain } from './client';

jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));

describe('Brain failure diagnostics', () => {
  it('classifies an actual rejected ingest response as validation, retaining only safe diagnostics', async () => {
    const previous = { url: process.env.BRAIN_API_URL, secret: process.env.BRAIN_SHARED_SECRET };
    process.env.BRAIN_API_URL = 'http://brain.test';
    process.env.BRAIN_SHARED_SECRET = 'synthetic-test-secret';
    const response = {
      code: 'invalid_request',
      field: 'sourceMessageIds',
      error: 'PRIVATE_SOURCE_TEXT',
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 400 }));
    try {
      const error = await requestBrain('owner', 'POST', '/v1/ingest', {}).catch(
        (failure: unknown) => failure,
      );
      const failure = classifyBrainFailure(error, 'ingest');
      expect(failure).toMatchObject({
        code: 'brain_validation',
        upstreamStatus: 400,
        serviceCode: 'invalid_request',
        validationField: 'sourceMessageIds',
      });
      expect(failure.message).not.toContain('nicht erreichbar');
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_SOURCE_TEXT');
    } finally {
      fetchMock.mockRestore();
      if (previous.url) process.env.BRAIN_API_URL = previous.url;
      else delete process.env.BRAIN_API_URL;
      if (previous.secret) process.env.BRAIN_SHARED_SECRET = previous.secret;
      else delete process.env.BRAIN_SHARED_SECRET;
    }
  });

  it.each([
    [new DOMException('private content', 'TimeoutError'), 'extract', 'model_timeout'],
    [{ status: 429, message: 'private content' }, 'extract', 'model_rate_limit'],
    [{ status: 401 }, 'extract', 'model_auth'],
    [{ status: 402 }, 'extract', 'model_credit'],
    [{ response: { status: 503 } }, 'extract', 'model_unavailable'],
    [new BrainServiceError(503, undefined, 401), 'extract', 'brain_auth'],
    [new BrainServiceError(400), 'ingest', 'brain_validation'],
    [new BrainServiceError(413), 'ingest', 'brain_validation'],
    [new BrainServiceError(422), 'ingest', 'brain_validation'],
    [
      new BrainServiceError(409, undefined, 409, undefined, { serviceCode: 'version_conflict' }),
      'ingest',
      'brain_conflict',
    ],
    [
      new BrainServiceError(409, undefined, 409, undefined, { serviceCode: 'rebuild_state' }),
      'ingest',
      'brain_conflict',
    ],
    [
      new BrainServiceError(409, undefined, 409, undefined, { serviceCode: 'stale_sources' }),
      'ingest',
      'brain_source_changed',
    ],
    [
      new BrainServiceError(409, undefined, 409, undefined, { serviceCode: 'deleted_source' }),
      'ingest',
      'brain_source_changed',
    ],
    [new BrainServiceError(404), 'request', 'brain_not_found'],
    [new BrainServiceError(429), 'ingest', 'brain_rate_limit'],
    [{ status: 400 }, 'extract', 'model_request'],
    [
      new BrainServiceError(503, undefined, undefined, new DOMException('', 'TimeoutError')),
      'ingest',
      'brain_timeout',
    ],
    [{ name: 'MongoNetworkError' }, 'source', 'database'],
  ] as const)('classifies %s at %s as %s', (error, stage, code) => {
    expect(classifyBrainFailure(error, stage)).toMatchObject({
      code,
      incidentId: expect.any(String),
    });
  });

  it('stores a useful admin event without provider payloads, credentials, or source text', async () => {
    const insert = jest.fn(async () => undefined);
    const failure = classifyBrainFailure(
      {
        status: 429,
        message: 'SECRET_SOURCE_TEXT',
        request: { authorization: 'SECRET_ACCESS' },
        body: 'SECRET_SOURCE_TEXT',
      },
      'extract',
    );
    await createBrainFailureReporter(insert)({
      failure,
      userId: 'owner',
      operation: 'history',
      stage: 'extract',
      conversationId: 'conversation',
      messageId: 'message',
      modelLabel: 'Provider · Model',
      processed: 22,
      durationMs: 30100,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'cowork-chat',
        kind: 'brain',
        user: { id: 'owner' },
        context: expect.objectContaining({
          code: 'model_rate_limit',
          upstreamStatus: 429,
          processed: 22,
          incidentId: failure.incidentId,
        }),
      }),
    );
    expect(JSON.stringify(insert.mock.calls)).not.toContain('SECRET_');
  });

  it('writes controlled service validation metadata into the admin entry', async () => {
    const insert = jest.fn(async () => undefined);
    const failure = classifyBrainFailure(
      new BrainServiceError(400, 'PRIVATE_TEXT', 400, undefined, {
        serviceCode: 'invalid_request',
        validationField: 'facts.tags',
        validationReason: 'empty',
      }),
      'ingest',
    );
    await createBrainFailureReporter(insert)({
      failure,
      userId: 'owner',
      operation: 'history',
      stage: 'ingest',
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: failure.message,
        context: expect.objectContaining({
          code: 'brain_validation',
          upstreamStatus: 400,
          serviceCode: 'invalid_request',
          validationField: 'facts.tags',
          validationReason: 'empty',
        }),
      }),
    );
    expect(JSON.stringify(insert.mock.calls)).not.toContain('PRIVATE_TEXT');
  });
  it('drops forged diagnostic values again at the reporting boundary', async () => {
    const insert = jest.fn(async () => undefined);
    const failure = Object.assign(classifyBrainFailure(new BrainServiceError(400), 'ingest'), {
      serviceCode: 'PRIVATE_CODE',
      validationField: 'PRIVATE_FIELD',
      validationReason: 'PRIVATE_REASON',
    });
    await createBrainFailureReporter(insert)({
      failure,
      userId: 'owner',
      operation: 'history',
      stage: 'ingest',
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain('PRIVATE_');
  });
  it('does not turn a failed diagnostic write into another application failure', async () => {
    await expect(
      createBrainFailureReporter(async () => {
        throw new Error('private database detail');
      })({
        failure: classifyBrainFailure(new Error(), 'source'),
        userId: 'owner',
        operation: 'history',
        stage: 'source',
      }),
    ).resolves.toBeUndefined();
  });
  it('bounds diagnostic latency when the database does not respond', async () => {
    jest.useFakeTimers();
    try {
      const report = createBrainFailureReporter(() => new Promise(() => {}))({
        failure: classifyBrainFailure(new Error(), 'source'),
        userId: 'owner',
        operation: 'history',
        stage: 'source',
      });
      await jest.advanceTimersByTimeAsync(2000);
      await expect(report).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
