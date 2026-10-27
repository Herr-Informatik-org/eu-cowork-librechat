const request = require('supertest');
const express = require('express');

const mockStart = jest.fn();
const mockMailRouter = jest.fn();
const mockRuntime = { engine: { start: mockStart } };
const mockConfigure = jest.fn((_req, _res, next) => next());
const mockBan = jest.fn((_req, _res, next) => next());
jest.mock('@librechat/api', () => ({
  createMailAssistantRuntime: () => mockRuntime,
  createMailAssistantRouter: (runtime) => {
    mockMailRouter(runtime);
    const router = require('express').Router();
    router.get('/availability', (req, res) => res.json({ available: true, owner: req.user.id }));
    router.post('/run', (req, res) => res.json({ owner: req.user.id }));
    return router;
  },
  createMailAssistantCallbackRouter: () => require('express').Router(),
  createOfficeRouter: () => require('express').Router(),
  tenantContextMiddleware: (_req, _res, next) => next(),
  restoreTenantContextFromReq: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer native-session') return res.status(401).end();
    req.user = { id: 'session-owner' };
    next();
  },
  checkBan: (...args) => mockBan(...args),
  uaParser: (_req, _res, next) => next(),
  configMiddleware: (...args) => mockConfigure(...args),
  createFileLimiters: () => ({
    fileUploadIpLimiter: (_req, _res, next) => next(),
    fileUploadUserLimiter: (_req, _res, next) => next(),
  }),
}));
jest.mock('~/server/services/PermissionService', () => ({ findAccessibleResources: jest.fn() }));
jest.mock('../agents', () => ({ createAgentRouter: () => require('express').Router() }));
jest.mock('../agents/middleware', () => ({
  preAuthTenantMiddleware: jest.fn(),
  requireRemoteAgentAuth: jest.fn(),
  checkRemoteAgentsFeature: jest.fn(),
}));
jest.mock('../files/multer', () => ({
  createMulterInstance: async () => ({ single: () => (_req, _res, next) => next() }),
}));
jest.mock('../files/images', () => require('express').Router());
jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
const office = require('../office');

describe('native mail workspace authentication wiring', () => {
  let app;
  beforeEach(async () => {
    await office.initialize();
    app = express();
    app.use(express.json());
    app.use('/api/mail', office.web());
  });
  beforeEach(() => {
    mockBan.mockClear();
    mockConfigure.mockClear();
  });
  test('uses the same runtime without starting a duplicate worker', () => {
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockMailRouter).toHaveBeenCalledTimes(2);
    expect(mockMailRouter.mock.calls.every(([runtime]) => runtime === mockRuntime)).toBe(true);
  });
  test('rejects anonymous requests and Office API keys before configuration or data routes', async () => {
    await request(app).get('/api/mail/availability').expect(401);
    await request(app).get('/api/mail/availability').set('X-API-Key', 'office-key').expect(401);
    expect(mockBan).not.toHaveBeenCalled();
    expect(mockConfigure).not.toHaveBeenCalled();
  });
  test('runs native session authentication, ban and configuration checks', async () => {
    const result = await request(app)
      .get('/api/mail/availability')
      .set('Authorization', 'Bearer native-session')
      .expect(200);
    expect(result.body).toEqual({ available: true, owner: 'session-owner' });
    expect(mockBan).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledTimes(1);
  });
  test('uses the authenticated owner for a mutation rather than a body owner', async () => {
    const result = await request(app)
      .post('/api/mail/run')
      .set('Authorization', 'Bearer native-session')
      .send({ owner: 'other-user' })
      .expect(200);
    expect(result.body.owner).toBe('session-owner');
  });
});
