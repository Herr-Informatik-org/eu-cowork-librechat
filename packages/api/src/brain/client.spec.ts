import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { requestBrain, signBrainRequest, deleteBrainSources, BrainServiceError } from './client';

describe('signed Brain transport', () => {
  let server: Server;
  let captured: {
    method?: string;
    path?: string;
    user?: string;
    body?: string;
    signature?: string;
    expected?: string;
  };
  let status = 200;
  let responseBody: unknown = { ok: true };
  const previous = { url: process.env.BRAIN_API_URL, secret: process.env.BRAIN_SHARED_SECRET };

  beforeAll(async () => {
    process.env.BRAIN_SHARED_SECRET = 'synthetic-test-key';
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
      }
      const user = String(req.headers['x-brain-user']);
      const expected = createHmac('sha256', 'synthetic-test-key')
        .update(
          [
            req.method,
            req.url,
            req.headers['x-brain-timestamp'],
            req.headers['x-brain-nonce'],
            user,
            createHash('sha256').update(body).digest('hex'),
          ].join('\n'),
        )
        .digest('hex');
      captured = {
        method: req.method,
        path: req.url,
        user,
        body,
        signature: String(req.headers['x-brain-signature']),
        expected,
      };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.BRAIN_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await once(server, 'close');
    if (previous.url) {
      process.env.BRAIN_API_URL = previous.url;
    } else {
      delete process.env.BRAIN_API_URL;
    }
    if (previous.secret) {
      process.env.BRAIN_SHARED_SECRET = previous.secret;
    } else {
      delete process.env.BRAIN_SHARED_SECRET;
    }
  });
  beforeEach(() => {
    status = 200;
    responseBody = { ok: true };
  });

  it('signs the exact UTF-8 body, path and authenticated owner', async () => {
    await requestBrain('owner-1', 'POST', '/v1/nodes?scope=B%C3%BCro', {
      text: 'Grüsse',
      userId: 'forged',
    });
    expect(captured.user).toBe('owner-1');
    expect(captured.signature).toBe(captured.expected);
    expect(captured.body).toBe('{"text":"Grüsse","userId":"forged"}');
  });
  it('changes the signature for each owner and nonce', () => {
    const request = {
      method: 'GET',
      path: '/v1/graph',
      userId: 'a',
      body: '',
      secret: 'test',
      timestamp: '1',
      nonce: 'one',
    };
    expect(signBrainRequest(request)['x-brain-signature']).not.toBe(
      signBrainRequest({ ...request, userId: 'b' })['x-brain-signature'],
    );
    expect(signBrainRequest(request)['x-brain-signature']).not.toBe(
      signBrainRequest({ ...request, nonce: 'two' })['x-brain-signature'],
    );
  });
  it('fails deletion closed on service outage', async () => {
    status = 500;
    await expect(
      deleteBrainSources('owner-1', ['conversation-1'], ['message-1']),
    ).rejects.toMatchObject({ status: 503 });
    expect(captured.path).toBe('/v1/sources');
    expect(JSON.parse(captured.body || '{}')).toEqual({
      conversationIds: ['conversation-1'],
      messageIds: ['message-1'],
    });
  });
  it('preserves a version-conflict response without disclosing upstream bodies', async () => {
    status = 409;
    await expect(
      requestBrain('owner-1', 'PATCH', '/v1/nodes/n', { version: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('retains only allowlisted validation details from the signed service response', async () => {
    status = 400;
    responseBody = {
      code: 'invalid_request',
      field: 'tags',
      reason: 'empty',
      error: 'PRIVATE_SOURCE_TEXT',
      input: { authorization: 'PRIVATE_ACCESS' },
    };
    const error = await requestBrain('owner', 'POST', '/v1/ingest', {}).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(BrainServiceError);
    expect(error).toMatchObject({
      status: 400,
      upstreamStatus: 400,
      serviceCode: 'invalid_request',
      validationField: 'tags',
      validationReason: 'empty',
    });
    expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    expect((error as Error).message).not.toContain('PRIVATE_');
  });
  it.each(['sourceManifestId', 'sourceCount', 'pageCount', 'pageIndex'])(
    'retains the safe manifest diagnostic %s without original source content',
    async (field) => {
      status = 409;
      responseBody = {
        code: 'source_manifest_state',
        field,
        reason: 'invalid_value',
        error: 'PRIVATE_SOURCE_TEXT',
      };
      const error = await requestBrain(
        'owner',
        'POST',
        '/v1/source-manifests/test/complete',
        {},
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        serviceCode: 'source_manifest_state',
        validationField: field,
        validationReason: 'invalid_value',
      });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    },
  );
  it.each([
    {
      code: 'PRIVATE_CODE',
      field: 'tags',
      reason: 'empty',
      keep: { validationField: 'tags', validationReason: 'empty' },
      drop: 'serviceCode',
    },
    {
      code: 'invalid_request',
      field: 'facts.0.PRIVATE_PATH',
      reason: 'too_long',
      keep: { serviceCode: 'invalid_request', validationReason: 'too_long' },
      drop: 'validationField',
    },
    {
      code: 'invalid_request',
      field: 'tags',
      reason: 'PRIVATE_REASON',
      keep: { serviceCode: 'invalid_request', validationField: 'tags' },
      drop: 'validationReason',
    },
  ])(
    'drops an untrusted diagnostic $drop while retaining independent safe fields',
    async ({ code, field, reason, keep, drop }) => {
      status = 400;
      responseBody = { code, field, reason, error: 'PRIVATE_SOURCE_TEXT' };
      const error = await requestBrain('owner', 'POST', '/v1/ingest', {}).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject(keep);
      expect((error as unknown as Record<string, unknown>)[drop]).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    },
  );
  it('cancels an oversized error stream without retaining partial diagnostics', async () => {
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ code: 'invalid_request', field: 'tags', error: 'x'.repeat(5000) }),
            ),
          );
        },
        cancel,
      }),
      { status: 400 },
    );
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response);
    try {
      const error = await requestBrain('owner', 'POST', '/v1/ingest', {}).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ status: 400, upstreamStatus: 400 });
      expect((error as BrainServiceError).serviceCode).toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('keeps the HTTP rejection when the response contains malformed JSON', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('PRIVATE_INVALID_JSON', { status: 400 }));
    try {
      const error = await requestBrain('owner', 'POST', '/v1/ingest', {}).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ status: 400, upstreamStatus: 400 });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_');
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('fails deletion closed when the service is configured but its key is missing', async () => {
    delete process.env.BRAIN_SHARED_SECRET;
    try {
      await expect(deleteBrainSources('owner', ['conversation'])).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      process.env.BRAIN_SHARED_SECRET = 'synthetic-test-key';
    }
  });
  it('retains the internal authentication status without exposing the service response', async () => {
    status = 401;
    await expect(requestBrain('owner', 'GET', '/v1/graph')).rejects.toMatchObject({
      name: 'BrainServiceError',
      status: 503,
      upstreamStatus: 401,
    });
  });

  it('preserves a transport timeout for diagnostics', async () => {
    const error = new DOMException('Synthetic timeout', 'TimeoutError');
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(error);
    await expect(requestBrain('owner', 'GET', '/v1/graph')).rejects.toMatchObject({
      status: 503,
      cause: error,
    });
  });
});
