import express from 'express';
import request from 'supertest';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { BrainHistoryStatus, BrainRebuildStatus } from 'librechat-data-provider';
import type { IRole, IUser } from '@librechat/data-schemas';
import { createBrainRouter } from './router';
import { requestBrain, BrainServiceError } from './client';
import type { BrainHistoryService } from './history';

jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  requestBrain: jest.fn(),
  isBrainConfigured: () => true,
}));
const proxy = jest.mocked(requestBrain);
const idle: BrainHistoryStatus = {
  available: true,
  status: 'idle',
  total: 0,
  processed: 0,
  saved: 0,
  skipped: 0,
};
const ready: BrainRebuildStatus = {
  rebuild: {
    id: 'generation-new',
    status: 'ready',
    revision: 1,
    createdAt: '2026-09-14T12:00:00Z',
    counts: { current: 0, staged: 3, preserved: 0, retired: 0 },
    preview: { added: [], retired: [] },
    previewTruncated: false,
  },
  rollbackAvailable: false,
};
function setup(denied: Permissions[] = []) {
  const history: jest.Mocked<BrainHistoryService> = {
    status: jest
      .fn<ReturnType<BrainHistoryService['status']>, Parameters<BrainHistoryService['status']>>()
      .mockResolvedValue(idle),
    start: jest
      .fn<ReturnType<BrainHistoryService['start']>, Parameters<BrainHistoryService['start']>>()
      .mockResolvedValue(idle),
    pause: jest
      .fn<ReturnType<BrainHistoryService['pause']>, Parameters<BrainHistoryService['pause']>>()
      .mockResolvedValue(idle),
    settle: jest
      .fn<ReturnType<BrainHistoryService['settle']>, Parameters<BrainHistoryService['settle']>>()
      .mockResolvedValue(undefined),
  };
  const reportFailure = jest.fn(async () => {});
  const role = {
    name: 'USER',
    permissions: {
      [PermissionTypes.MEMORIES]: Object.fromEntries(
        [Permissions.USE, Permissions.READ, Permissions.CREATE, Permissions.UPDATE].map(
          (permission) => [permission, !denied.includes(permission)],
        ),
      ),
    },
  } as unknown as IRole;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'owner', role: 'USER' } as IUser;
    next();
  });
  app.use(
    '/api/brain',
    createBrainRouter({ getRoleByName: async () => role, history, reportFailure }),
  );
  return { app, history, reportFailure };
}
beforeEach(() => proxy.mockReset());

describe('Brain rebuild HTTP orchestration', () => {
  it('returns an existing ready preview without restarting its completed worker', async () => {
    const { app, history } = setup();
    proxy.mockResolvedValue(ready);
    const result = await request(app)
      .post('/api/brain/rebuild')
      .send({ ownerId: 'other', rebuildId: 'forged' });
    expect(result.status).toBe(201);
    expect(result.body.rebuild.status).toBe('ready');
    expect(history.start).not.toHaveBeenCalled();
    expect(proxy).toHaveBeenCalledWith('owner', 'POST', '/v1/rebuild', {});
  });
  it('starts only the generation returned by the owner-scoped service', async () => {
    const { app, history } = setup();
    proxy.mockResolvedValue({ ...ready, rebuild: { ...ready.rebuild!, status: 'building' } });
    expect(
      (await request(app).post('/api/brain/rebuild').send({ rebuildId: 'forged' })).status,
    ).toBe(201);
    expect(history.start).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'owner' }) }),
      { rebuildId: 'generation-new' },
    );
  });
  it.each([
    ['/rebuild', Permissions.CREATE],
    ['/rebuild', Permissions.UPDATE],
    ['/rebuild', Permissions.USE],
    ['/rebuild/generation-new/activate', Permissions.CREATE],
    ['/rebuild/generation-new/activate', Permissions.UPDATE],
    ['/rebuild/generation-old/discard', Permissions.UPDATE],
    ['/rebuild/rollback', Permissions.UPDATE],
    ['/rebuild/rollback', Permissions.CREATE],
    ['/rebuild/rollback', Permissions.READ],
  ] as const)('requires %s permission %s before any state changes', async (path, permission) => {
    const { app, history } = setup([permission]);
    expect((await request(app).post(`/api/brain${path}`).send({})).status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
    expect(history.start).not.toHaveBeenCalled();
    expect(history.pause).not.toHaveBeenCalled();
  });
  it.each(['/rebuild', '/rebuild/generation-new/activate', '/rebuild/rollback'])(
    'blocks %s when current account eligibility is revoked',
    async (path) => {
      const { app, history } = setup();
      history.status.mockResolvedValue({
        ...idle,
        available: false,
        reason: 'Brain ist ausgeschaltet.',
      });
      const result = await request(app).post(`/api/brain${path}`).send({});
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Brain ist ausgeschaltet.');
      expect(proxy).not.toHaveBeenCalled();
      expect(history.start).not.toHaveBeenCalled();
    },
  );
  it('binds a stale discard to its URL generation without pausing a replacement worker', async () => {
    const { app, history } = setup();
    proxy.mockRejectedValue(new BrainServiceError(409));
    const result = await request(app)
      .post('/api/brain/rebuild/generation-old/discard')
      .send({ rebuildId: 'generation-new' });
    expect(result.status).toBe(409);
    expect(history.pause).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'owner' }) }),
      'generation-old',
    );
    expect(history.pause).not.toHaveBeenCalledWith(expect.anything(), 'generation-new');
    expect(history.start).not.toHaveBeenCalled();
    expect(proxy).toHaveBeenCalledWith(
      'owner',
      'POST',
      '/v1/rebuild/generation-old/discard',
      { rebuildId: 'generation-new' },
      120000,
    );
  });
  it.each([
    ['/rebuild/generation-new/activate', 'status'],
    ['/rebuild/rollback', 'status'],
    ['/rebuild/generation-old/discard', 'pause'],
  ] as const)('reports a store failure at %s as a safe Brain incident', async (path, operation) => {
    const { app, history, reportFailure } = setup();
    history[operation].mockRejectedValue(new Error('sensitive database detail'));
    const result = await request(app).post(`/api/brain${path}`).send({});
    expect(result.status).toBe(503);
    expect(result.body.incidentId).toEqual(expect.any(String));
    expect(result.body.errorCode).toEqual(expect.any(String));
    expect(JSON.stringify(result.body)).not.toContain('sensitive database detail');
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        operation: 'history',
        stage: 'request',
        failure: expect.objectContaining({ incidentId: result.body.incidentId }),
      }),
    );
    expect(proxy).not.toHaveBeenCalled();
  });

  it('keeps discard available after opt-out so the user can remove staged analysis', async () => {
    const { app, history } = setup();
    history.status.mockResolvedValue({ ...idle, available: false });
    proxy.mockResolvedValue({ rebuild: null, rollbackAvailable: false });
    expect(
      (await request(app).post('/api/brain/rebuild/generation-old/discard').send({})).status,
    ).toBe(201);
    expect(history.pause).toHaveBeenCalledWith(expect.anything(), 'generation-old');
  });
});
