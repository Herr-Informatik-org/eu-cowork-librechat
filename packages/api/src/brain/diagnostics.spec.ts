import { classifyBrainFailure, createBrainFailureReporter } from './diagnostics';
import { BrainServiceError } from './client';

jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));

describe('Brain failure diagnostics', () => {
  it.each([
    [new DOMException('private content', 'TimeoutError'), 'extract', 'model_timeout'],
    [{ status: 429, message: 'private content' }, 'extract', 'model_rate_limit'],
    [{ status: 401 }, 'extract', 'model_auth'],
    [{ status: 402 }, 'extract', 'model_credit'],
    [{ response: { status: 503 } }, 'extract', 'model_unavailable'],
    [new BrainServiceError(503, undefined, 401), 'extract', 'brain_auth'],
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
