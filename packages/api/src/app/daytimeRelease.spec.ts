/// <reference types="jest" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createReleaseLifecycle } from './daytimeRelease';

const token = 'local-test-token-with-at-least-32-characters';
class RedisFixture {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, _mode: 'NX') {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(_script: string, _count: number, key: string, value: string) {
    if (this.values.get(key) !== value) return 0;
    this.values.delete(key);
    return 1;
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(releaseId = 'blue', redis = new RedisFixture()) {
  const lifecycle = createReleaseLifecycle({ env: { KISUNO_RELEASE_ID: releaseId }, token });
  const work = { jobs: 0, pending: 0, paused: 0 };
  const started = jest.fn();
  const stopped = jest.fn();
  const checkRedis = jest.fn(async () => true);
  lifecycle.configure({ redis, checkRedis, generationSnapshot: async () => ({ ...work }) });
  lifecycle.registerWorker('fixture', { start: started, stop: stopped });
  lifecycle.markReady();
  return { lifecycle, redis, work, started, stopped, checkRedis };
}

describe('daytime release lifecycle', () => {
  it('starts in standby without starting work and refuses seal before drain', async () => {
    const f = fixture();
    expect((await f.lifecycle.snapshot()).state).toBe('standby');
    expect(f.started).not.toHaveBeenCalled();
    await expect(f.lifecycle.action('seal')).rejects.toMatchObject({
      code: 'RELEASE_NOT_DRAINING',
    });
  });

  it('retires a fully warmed standby candidate without starting its workers', async () => {
    const f = fixture();
    await f.lifecycle.action('pause-workers');
    await f.lifecycle.action('drain');
    expect((await f.lifecycle.action('seal')).state).toBe('sealed');
    expect(f.started).not.toHaveBeenCalled();
  });

  it('serializes repeated activation without duplicate worker starts', async () => {
    const f = fixture();
    await Promise.all([f.lifecycle.action('activate'), f.lifecycle.action('activate')]);
    expect(f.started).toHaveBeenCalledTimes(1);
    expect((await f.lifecycle.snapshot()).workersActive).toBe(true);
  });

  it('pauses only scheduling and hands the worker lock over after existing work completes', async () => {
    const a = fixture();
    const b = fixture('green', a.redis);
    await a.lifecycle.action('activate');
    const pending = deferred();
    const started = deferred();
    const task = a.lifecycle.runTask(
      'mail',
      () => {
        started.resolve();
        return pending.promise;
      },
      { worker: true },
    );
    await started.promise;
    const paused = await a.lifecycle.action('pause-workers');
    expect(paused).toMatchObject({ state: 'active', workersActive: false, workerTasks: 1 });
    await expect(
      a.lifecycle.runTask('late-timer', async () => undefined, { worker: true }),
    ).rejects.toMatchObject({ code: 'RELEASE_WORKERS_PAUSED' });
    await expect(a.lifecycle.runTask('user-action', async () => 'accepted')).resolves.toBe(
      'accepted',
    );
    await expect(b.lifecycle.action('activate')).rejects.toMatchObject({
      code: 'RELEASE_WORKERS_OWNED_ELSEWHERE',
    });
    pending.resolve();
    await task;
    await a.lifecycle.snapshot();
    await b.lifecycle.action('activate');
    expect(b.started).toHaveBeenCalledTimes(1);
    await a.lifecycle.action('drain');
    expect((await a.lifecycle.action('seal')).state).toBe('sealed');
    expect((await b.lifecycle.snapshot()).state).toBe('active');
  });

  it('retains a detached generation after its initiating HTTP response has ended', async () => {
    const f = fixture();
    await f.lifecycle.action('activate');
    const pending = deferred();
    const generation = f.lifecycle.runTask('generation', () => pending.promise);
    await f.lifecycle.action('drain');
    expect((await f.lifecycle.snapshot()).tasks).toBe(1);
    await expect(f.lifecycle.action('seal')).rejects.toMatchObject({ code: 'RELEASE_STILL_BUSY' });
    pending.resolve();
    await generation;
    expect((await f.lifecycle.action('seal')).state).toBe('sealed');
    await expect(f.lifecycle.runTask('late-task', async () => undefined)).rejects.toMatchObject({
      code: 'RELEASE_SEALED',
    });
  });

  it.each(['jobs', 'pending', 'paused'] as const)(
    'refuses retirement while %s remain',
    async (key) => {
      const f = fixture();
      await f.lifecycle.action('activate');
      await f.lifecycle.action('drain');
      f.work[key] = 1;
      await expect(f.lifecycle.action('seal')).rejects.toMatchObject({
        code: 'RELEASE_STILL_BUSY',
      });
      expect((await f.lifecycle.snapshot()).state).toBe('draining');
      f.work[key] = 0;
      expect((await f.lifecycle.action('seal')).state).toBe('sealed');
    },
  );

  it('fails closed on Redis loss and never substitutes memory storage', async () => {
    const f = fixture();
    f.checkRedis.mockResolvedValue(false);
    expect((await f.lifecycle.snapshot()).blockers).toContain('RELEASE_REDIS_UNAVAILABLE');
    await expect(f.lifecycle.action('activate')).rejects.toMatchObject({
      code: 'RELEASE_NOT_READY',
    });
    expect(f.started).not.toHaveBeenCalled();
  });

  it('keeps the lock if a worker cannot be paused', async () => {
    const f = fixture();
    f.stopped.mockImplementation(() => {
      throw new Error('private failure');
    });
    await f.lifecycle.action('activate');
    await expect(f.lifecycle.action('pause-workers')).rejects.toMatchObject({
      code: 'RELEASE_WORKER_PAUSE_FAILED',
    });
    expect((await f.lifecycle.snapshot()).blockers).toContain('RELEASE_WORKER_STATE_UNKNOWN');
    expect(f.redis.values.size).toBe(1);
    await expect(f.lifecycle.action('activate')).rejects.toMatchObject({
      code: 'RELEASE_NOT_READY',
    });
  });

  it('refuses a changed worker-lock owner instead of deleting another release lock', async () => {
    const f = fixture();
    await f.lifecycle.action('activate');
    f.redis.values.set('kisuno:release:workers:v1', 'different-owner');
    await expect(f.lifecycle.action('pause-workers')).rejects.toMatchObject({
      code: 'RELEASE_WORKER_LOCK_CHANGED',
    });
    expect(await f.redis.get('kisuno:release:workers:v1')).toBe('different-owner');
  });

  it('detects worker-lock loss, stops scheduling and never deletes the new owner', async () => {
    const f = fixture();
    await f.lifecycle.action('activate');
    f.redis.values.set('kisuno:release:workers:v1', 'replacement');
    expect(await f.lifecycle.snapshot()).toMatchObject({ ready: false, workersActive: false });
    await expect(
      f.lifecycle.runTask('late-worker', async () => undefined, { worker: true }),
    ).rejects.toMatchObject({ code: 'RELEASE_WORKERS_PAUSED' });
    expect(await f.redis.get('kisuno:release:workers:v1')).toBe('replacement');
    expect(f.stopped).toHaveBeenCalled();
  });

  it('does not mistake a concurrent legitimate lock handover for ownership loss', async () => {
    const f = fixture();
    const b = fixture('green', f.redis);
    await f.lifecycle.action('activate');
    const entered = deferred();
    const allowRead = deferred();
    const originalGet = f.redis.get.bind(f.redis);
    jest.spyOn(f.redis, 'get').mockImplementationOnce(async (key) => {
      entered.resolve();
      await allowRead.promise;
      return originalGet(key);
    });
    const snapshot = f.lifecycle.snapshot();
    await entered.promise;
    await f.lifecycle.action('pause-workers');
    await b.lifecycle.action('activate');
    allowRead.resolve();
    expect(await snapshot).toMatchObject({ ready: true, workersActive: false, blockers: [] });
    expect((await b.lifecycle.snapshot()).workersActive).toBe(true);
  });

  it('does not seal from a work snapshot that raced new local activity', async () => {
    const f = fixture();
    await f.lifecycle.action('activate');
    await f.lifecycle.action('drain');
    f.checkRedis.mockImplementationOnce(async () => {
      await f.lifecycle.runTask('late-persist', async () => undefined);
      return true;
    });
    await expect(f.lifecycle.action('seal')).rejects.toMatchObject({ code: 'RELEASE_STILL_BUSY' });
    expect((await f.lifecycle.action('seal')).state).toBe('sealed');
  });

  it('bounds stuck checks without declaring idle or terminating a process', async () => {
    const lifecycle = createReleaseLifecycle({
      env: { KISUNO_RELEASE_ID: 'blue' },
      token,
      timeoutMs: 10,
    });
    lifecycle.configure({
      redis: new RedisFixture(),
      checkRedis: async () => true,
      generationSnapshot: () => new Promise(() => {}),
    });
    lifecycle.markReady();
    expect(await lifecycle.snapshot()).toMatchObject({
      ready: false,
      quiescent: false,
      blockers: ['RELEASE_WORK_STATE_UNKNOWN'],
    });
  });

  it('requires the managed browser contract and rejects old PWA builds', () => {
    const f = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-build-'));
    try {
      expect(() => f.lifecycle.verifyBuild(dir)).toThrow();
      fs.writeFileSync(
        path.join(dir, 'release-contract.json'),
        JSON.stringify({ schemaVersion: 1, managed: true, pwaEnabled: true, autoReload: false }),
      );
      expect(() => f.lifecycle.verifyBuild(dir)).toThrow('RELEASE_BUILD_CONTRACT_INVALID');
      fs.writeFileSync(
        path.join(dir, 'release-contract.json'),
        JSON.stringify({ schemaVersion: 1, managed: true, pwaEnabled: false, autoReload: false }),
      );
      expect(() => f.lifecycle.verifyBuild(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a public or symlinked token file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-token-'));
    const file = path.join(dir, 'token');
    const link = path.join(dir, 'link');
    try {
      fs.writeFileSync(file, token, { mode: 0o644 });
      expect(() =>
        createReleaseLifecycle({
          env: { KISUNO_RELEASE_ID: 'blue', KISUNO_RELEASE_CONTROL_TOKEN_FILE: file },
        }),
      ).toThrow('RELEASE_TOKEN_FILE_UNSAFE');
      fs.chmodSync(file, 0o600);
      fs.symlinkSync(file, link);
      expect(() =>
        createReleaseLifecycle({
          env: { KISUNO_RELEASE_ID: 'blue', KISUNO_RELEASE_CONTROL_TOKEN_FILE: link },
        }),
      ).toThrow();
      expect(() =>
        createReleaseLifecycle({
          env: { KISUNO_RELEASE_ID: 'blue', KISUNO_RELEASE_CONTROL_TOKEN_FILE: file },
        }),
      ).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an existing HTTP stream alive through drain and rejects new work until activation', async () => {
    const f = fixture();
    const app = express();
    const finish = deferred();
    const entered = deferred();
    app.use(f.lifecycle.middleware);
    app.get('/health', (_req, res) => {
      res.end('healthy');
    });
    app.get('/stream', async (_req, res) => {
      res.write('first');
      entered.resolve();
      await finish.promise;
      res.end('last');
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address missing');
    const request = (route: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: address.port, path: route }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, body }));
          })
          .on('error', reject);
      });
    try {
      expect((await request('/health')).status).toBe(200);
      expect((await request('/stream')).status).toBe(503);
      await f.lifecycle.action('activate');
      const stream = request('/stream');
      await entered.promise;
      expect((await f.lifecycle.snapshot()).requests).toBe(1);
      await f.lifecycle.action('pause-workers');
      expect((await f.lifecycle.snapshot()).state).toBe('active');
      await f.lifecycle.action('drain');
      await expect(f.lifecycle.action('seal')).rejects.toMatchObject({
        code: 'RELEASE_STILL_BUSY',
      });
      expect((await request('/stream')).status).toBe(503);
      finish.resolve();
      expect(await stream).toEqual({ status: 200, body: 'firstlast' });
      expect((await f.lifecycle.action('seal')).state).toBe('sealed');
    } finally {
      finish.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('authenticates the separate local control port and rejects bodies and foreign routes', async () => {
    const f = fixture();
    const server = await f.lifecycle.startControl({ host: '127.0.0.1', port: 0 });
    if (!server) throw new Error('server missing');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address missing');
    const request = (method: string, route: string, authorization?: string, body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            method,
            path: route,
            headers: {
              ...(authorization && { authorization }),
              ...(body && { 'content-length': Buffer.byteLength(body) }),
            },
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              text += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: text }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect((await request('GET', '/_kisuno/release/status')).status).toBe(401);
      expect((await request('GET', '/_kisuno/release/status', 'Bearer wrong')).status).toBe(401);
      expect((await request('GET', '/_kisuno/release/status', 'Bearer ' + token)).status).toBe(200);
      expect(
        (await request('POST', '/_kisuno/release/activate', 'Bearer ' + token, '{}')).status,
      ).toBe(400);
      expect((await request('POST', '/other', 'Bearer ' + token)).status).toBe(404);
      expect((await request('POST', '/_kisuno/release/activate', 'Bearer ' + token)).status).toBe(
        200,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
