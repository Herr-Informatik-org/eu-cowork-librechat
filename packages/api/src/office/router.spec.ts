import express, { Router } from 'express';
import request from 'supertest';
import type { ErrorRequestHandler } from 'express';
import type {
  AppConfig,
  IUser,
  IConversation,
  IMessage,
  IMongoFile,
} from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import type { OfficeDependencies } from './router';
import { createOfficeRouter } from './router';

const owner = 'owner';
const uploadRequest = {
  spec: 'eu-strong',
  file_id: '09db989b-9a49-4d42-af62-7d64812e693d',
  width: '640',
  height: '480',
};
const textRequest = {
  spec: 'eu-strong',
  text: 'Summarize this message.',
  messageId: 'message-1',
  parentMessageId: null,
  conversationId: 'new',
  clientRequestId: 'request-1',
};
const config = {
  modelSpecs: {
    list: [
      {
        name: 'eu-strong',
        label: 'EU Stark',
        insight: { intelligence: 4, tokenCost: 2, processingRegion: 'europe' },
        preset: { endpoint: 'TensorX', model: 'glm-5.3', promptPrefix: 'private instructions' },
      },
      {
        name: 'hidden',
        label: 'Hidden',
        showInMenu: false,
        preset: { endpoint: 'TensorX', model: 'hidden' },
      },
      {
        name: 'shared-agent',
        label: 'Shared agent',
        preset: { endpoint: 'agents', agent_id: 'agent-shared' },
      },
      {
        name: 'private-agent',
        label: 'Private agent',
        preset: { endpoint: 'agents', agent_id: 'agent-private' },
      },
    ],
  },
} as AppConfig;

function setup() {
  const nativeChat = Router();
  nativeChat.post('/chat', (req, res) => {
    res.json({ nativeBody: req.body, user: req.user });
  });
  nativeChat.post('/chat/abort', (_req, res) => {
    res.json({ aborted: true });
  });
  nativeChat.get('/chat/stream/:id', (_req, res) => {
    res.type('text/event-stream').send('data: native\n\n');
  });
  nativeChat.get('/chat/status/:id', (_req, res) => {
    res.json({ status: 'running' });
  });
  nativeChat.get('/chat/active', (_req, res) => {
    res.json({ activeJobIds: [] });
  });
  nativeChat.use((_req, res) => {
    res.json({ unsafeNativeRoute: true });
  });
  const images = Router();
  images.post('/', (req, res) => {
    res.json({ file_id: 'image-native', metadata: req.body });
  });
  const deps: OfficeDependencies = {
    authenticate: [
      (req, res, next) => {
        if (req.headers.authorization !== 'Bearer valid-key') {
          res.status(401).end();
          return;
        }
        (req as ServerRequest).user = { id: owner, role: 'USER' } as IUser;
        next();
      },
    ],
    configure: (req, _res, next) => {
      (req as ServerRequest).config = config;
      next();
    },
    chatRouter: nativeChat,
    imageUpload: [],
    imageRouter: images,
    cleanupUpload: jest.fn().mockResolvedValue(undefined),
    remoteAgentIds: jest.fn().mockResolvedValue(new Set(['agent-shared'])),
    getFiles: jest.fn().mockResolvedValue([]),
    getConvo: jest.fn().mockResolvedValue(null),
    getConvosByCursor: jest.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
    getMessages: jest.fn().mockResolvedValue([]),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/agents/office', createOfficeRouter(deps));
  const errors: unknown[] = [];
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    errors.push(error);
    res.status(500).json({ error: 'Interner Fehler.' });
  };
  app.use(errorHandler);
  return { app, deps, errors };
}
const authenticated = (req: request.Test) => req.set('Authorization', 'Bearer valid-key');

describe('Office native chat transport', () => {
  it.each(['getConvosByCursor', 'getConvo', 'getMessages'] as const)(
    'forwards rejected %s history operations to the error handler',
    async (operation) => {
      const { app, deps, errors } = setup();
      const error = new Error('Database unavailable');
      jest.mocked(deps.getConvo).mockResolvedValue({ conversationId: 'owned' } as IConversation);
      jest.mocked(deps[operation]).mockRejectedValue(error);
      const path = operation === 'getConvosByCursor' ? '/conversations' : '/conversations/owned';
      await authenticated(request(app).get('/api/agents/office' + path)).expect(500);
      expect(errors).toEqual([error]);
    },
  );
  it('forwards rejected card and chat file lookup operations to the error handler', async () => {
    const { app, deps, errors } = setup();
    const error = new Error('Lookup unavailable');
    jest.mocked(deps.remoteAgentIds).mockRejectedValueOnce(error);
    await authenticated(request(app).get('/api/agents/office/models')).expect(500);
    jest.mocked(deps.getFiles).mockRejectedValueOnce(error);
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'image-1' }] })
      .expect(500);
    expect(errors).toEqual([error, error]);
  });
  it('removes the temporary upload when a card lookup fails', async () => {
    const { app, deps, errors } = setup();
    const error = new Error('Permissions unavailable');
    jest.mocked(deps.remoteAgentIds).mockRejectedValueOnce(error);
    await authenticated(request(app).post('/api/agents/office/files/images'))
      .send(uploadRequest)
      .expect(500);
    expect(deps.cleanupUpload).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([error]);
  });
  it('forwards upload cleanup failures without an unhandled rejection', async () => {
    const { app, deps, errors } = setup();
    const error = new Error('Cleanup unavailable');
    jest.mocked(deps.cleanupUpload).mockRejectedValueOnce(error);
    await authenticated(request(app).post('/api/agents/office/files/images')).send({}).expect(500);
    expect(errors).toEqual([error]);
  });
  it('requires authentication before exposing model specs or history', async () => {
    const { app, deps } = setup();
    await request(app).get('/api/agents/office/models').expect(401);
    await request(app).get('/api/agents/office/conversations').expect(401);
    expect(deps.getConvosByCursor).not.toHaveBeenCalled();
  });
  it('returns visible cards without private prompts or inaccessible agents', async () => {
    const { app } = setup();
    const result = await authenticated(request(app).get('/api/agents/office/models')).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.data.map((spec: { id: string }) => spec.id)).toEqual([
      'eu-strong',
      'shared-agent',
    ]);
    expect(result.body.data[0].insight).toEqual({
      intelligence: 4,
      tokenCost: 2,
      processingRegion: 'europe',
    });
    expect(JSON.stringify(result.body)).not.toContain('private instructions');
    expect(result.body.data[0].preset).toEqual({ endpoint: 'TensorX', model: 'glm-5.3' });
  });
  it('uses only the authenticated owner for paginated history', async () => {
    const { app, deps } = setup();
    await authenticated(
      request(app).get('/api/agents/office/conversations?limit=999&cursor=next&user=other'),
    ).expect(200);
    expect(deps.getConvosByCursor).toHaveBeenCalledWith(owner, {
      cursor: 'next',
      limit: 100,
      isArchived: false,
    });
  });
  it('does not query messages for a missing or foreign conversation', async () => {
    const { app, deps } = setup();
    await authenticated(request(app).get('/api/agents/office/conversations/foreign')).expect(404);
    expect(deps.getConvo).toHaveBeenCalledWith(owner, 'foreign');
    expect(deps.getMessages).not.toHaveBeenCalled();
  });
  it('returns stored messages for an owned conversation', async () => {
    const { app, deps } = setup();
    const conversation = { conversationId: 'owned', user: owner } as IConversation;
    const messages = [{ messageId: 'stored', user: owner }] as IMessage[];
    jest.mocked(deps.getConvo).mockResolvedValue(conversation);
    jest.mocked(deps.getMessages).mockResolvedValue(messages);
    const result = await authenticated(
      request(app).get('/api/agents/office/conversations/owned'),
    ).expect(200);
    expect(deps.getMessages).toHaveBeenCalledWith({ user: owner, conversationId: 'owned' });
    expect(result.body).toEqual({ conversation, messages });
  });
  it('binds endpoint, model and private instructions server-side before native chat', async () => {
    const { app } = setup();
    const result = await authenticated(request(app).post('/api/agents/office/chat'))
      .send(textRequest)
      .expect(200);
    expect(result.body.nativeBody).toMatchObject({
      endpoint: 'TensorX',
      endpointType: 'custom',
      model: 'glm-5.3',
      promptPrefix: 'private instructions',
      spec: 'eu-strong',
      messageId: 'message-1',
      text: textRequest.text,
      files: [],
    });
    expect(result.body.user.id).toBe(owner);
  });
  it.each([
    'model',
    'endpoint',
    'promptPrefix',
    'user',
    'ephemeralAgent',
    'isTemporary',
    'agent_id',
  ])('rejects client-supplied %s', async (field) => {
    const { app } = setup();
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, [field]: 'override' })
      .expect(400);
  });
  it.each(['hidden', 'private-agent', 'unknown'])(
    'rejects unavailable spec %s at execution time',
    async (spec) => {
      const { app } = setup();
      await authenticated(request(app).post('/api/agents/office/chat'))
        .send({ ...textRequest, spec })
        .expect(403);
    },
  );
  it('refuses foreign conversation ids before invoking native chat', async () => {
    const { app, deps } = setup();
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, conversationId: 'foreign' })
      .expect(404);
    expect(deps.getConvo).toHaveBeenCalledWith(owner, 'foreign');
  });
  it('refuses an unrelated parent message using an owner-and-conversation-scoped query', async () => {
    const { app, deps } = setup();
    jest
      .mocked(deps.getConvo)
      .mockResolvedValue({ conversationId: 'owned', user: owner } as IConversation);
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, conversationId: 'owned', parentMessageId: 'foreign-message' })
      .expect(400);
    expect(deps.getMessages).toHaveBeenCalledWith({
      user: owner,
      conversationId: 'owned',
      messageId: 'foreign-message',
    });
  });
  it('resolves owned image records instead of trusting client file paths', async () => {
    const { app, deps } = setup();
    const image = {
      file_id: 'image-1',
      type: 'image/png',
      filepath: '/images/owner/image.png',
    } as IMongoFile;
    jest.mocked(deps.getFiles).mockResolvedValue([image]);
    const result = await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'image-1' }] })
      .expect(200);
    expect(deps.getFiles).toHaveBeenCalledWith({ user: owner, file_id: { $in: ['image-1'] } });
    expect(result.body.nativeBody.files).toEqual([image]);
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'image-1', filepath: '/etc/passwd' }] })
      .expect(400);
  });
  it('rejects missing and non-image file records', async () => {
    const { app, deps } = setup();
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'foreign-image' }] })
      .expect(404);
    jest
      .mocked(deps.getFiles)
      .mockResolvedValue([{ file_id: 'pdf', type: 'application/pdf' } as IMongoFile]);
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'pdf' }] })
      .expect(404);
  });
  it('delegates uploads to the native image handler with server-bound metadata', async () => {
    const { app } = setup();
    const result = await authenticated(request(app).post('/api/agents/office/files/images'))
      .send(uploadRequest)
      .expect(200);
    expect(result.body).toEqual({
      file_id: 'image-native',
      metadata: {
        endpoint: 'TensorX',
        endpointType: 'custom',
        file_id: uploadRequest.file_id,
        width: 640,
        height: 480,
        context: 'message_attachment',
      },
    });
  });
  it('rejects an image after its expiry even before TTL cleanup', async () => {
    const { app, deps } = setup();
    jest
      .mocked(deps.getFiles)
      .mockResolvedValue([
        { file_id: 'expired-image', type: 'image/png', expiresAt: new Date(0) } as IMongoFile,
      ]);
    await authenticated(request(app).post('/api/agents/office/chat'))
      .send({ ...textRequest, files: [{ file_id: 'expired-image' }] })
      .expect(404);
  });
  it('rejects malformed native image metadata before processing', async () => {
    const { app } = setup();
    await authenticated(request(app).post('/api/agents/office/files/images'))
      .send({ ...uploadRequest, width: 'not-a-number' })
      .expect(400);
    await authenticated(request(app).post('/api/agents/office/files/images'))
      .send({ ...uploadRequest, file_id: 'not-a-uuid' })
      .expect(400);
  });
  it('removes staged uploads when the model or metadata is rejected', async () => {
    const { app, deps } = setup();
    await authenticated(request(app).post('/api/agents/office/files/images'))
      .send({ ...uploadRequest, tool_resource: 'code_interpreter' })
      .expect(400);
    await authenticated(request(app).post('/api/agents/office/files/images'))
      .send({ ...uploadRequest, spec: 'private-agent' })
      .expect(403);
    expect(deps.cleanupUpload).toHaveBeenCalledTimes(2);
  });
  it.each(['/files/images/', '/files/images//', '/files/images///'])(
    'cannot bypass upload validation through %s',
    async (path) => {
      const { app } = setup();
      const response = await authenticated(request(app).post('/api/agents/office' + path)).send({
        endpoint: 'private-provider',
        file_id: 'unvalidated',
      });
      expect([400, 404]).toContain(response.status);
      expect(response.body.file_id).toBeUndefined();
    },
  );
  it('reuses native stream, status and abort routes', async () => {
    const { app } = setup();
    const stream = await authenticated(
      request(app).get('/api/agents/office/chat/stream/owned'),
    ).expect(200);
    expect(stream.text).toContain('data: native');
    await authenticated(request(app).get('/api/agents/office/chat/status/owned')).expect(200, {
      status: 'running',
    });
    await authenticated(request(app).post('/api/agents/office/chat/abort'))
      .send({ conversationId: 'owned' })
      .expect(200, { aborted: true });
  });
  it.each([
    '/v1/models',
    '/agent-anything',
    '/chat/resume',
    '/chat//',
    '/chat/steer',
    '/files/images/avatar',
  ])('does not expose unrelated native route %s', async (path) => {
    const { app } = setup();
    await authenticated(request(app).post(`/api/agents/office${path}`))
      .send({})
      .expect(404);
  });
});
