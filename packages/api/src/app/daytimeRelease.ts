import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

interface ReleaseWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
interface ReleaseDependencies {
  checkRedis(): Promise<boolean>;
  generationSnapshot(): Promise<{ jobs: number; pending: number; paused: number }>;
  redis: {
    set(key: string, value: string, mode: 'NX'): Promise<string | null>;
    get(key: string): Promise<string | null>;
    eval(script: string, keyCount: number, key: string, value: string): Promise<unknown>;
  };
}

export interface ReleaseSnapshot {
  contract: 1;
  releaseId: string;
  state: 'standby' | 'active' | 'draining' | 'sealed';
  ready: boolean;
  redisReady: boolean;
  workersActive: boolean;
  workerTasks: number;
  requests: number;
  tasks: number;
  jobs: number;
  pending: number;
  paused: number;
  quiescent: boolean;
  blockers: string[];
}

export interface ReleaseLifecycle {
  readonly enabled: boolean;
  readonly releaseId: string;
  readonly state: ReleaseSnapshot['state'];
  readonly workersActive: boolean;
  runTask<T>(
    name: string,
    operation: () => T | Promise<T>,
    options?: { worker?: boolean },
  ): Promise<T>;
  snapshot(): Promise<ReleaseSnapshot>;
  action(name: string): Promise<ReleaseSnapshot>;
  middleware(req: Request, res: Response, next: NextFunction): void;
  configure(value: ReleaseDependencies): void;
  registerWorker(name: string, worker: ReleaseWorker): void;
  markReady(): void;
  verifyBuild(directory: string): void;
  startControl(options?: { host?: string; port?: number }): Promise<http.Server | undefined>;
}

const PREFIX = '/_kisuno/release/';
const WORKER_LOCK = 'kisuno:release:workers:v1';

function fault(code: string, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function readToken(file: string | undefined) {
  if (!file || !file.startsWith('/')) throw fault('RELEASE_TOKEN_FILE_REQUIRED', 500);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 512)
      throw fault('RELEASE_TOKEN_FILE_UNSAFE', 500);
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw fault('RELEASE_TOKEN_INVALID', 500);
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

export function createReleaseLifecycle({
  env = process.env,
  token,
  timeoutMs = 2000,
}: { env?: NodeJS.ProcessEnv; token?: string; timeoutMs?: number } = {}): ReleaseLifecycle {
  const enabled = Boolean(env.KISUNO_RELEASE_ID || env.KISUNO_RELEASE_CONTROL_TOKEN_FILE);
  const releaseId = env.KISUNO_RELEASE_ID || 'unmanaged';
  if (enabled && (!env.KISUNO_RELEASE_ID || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(releaseId)))
    throw fault('RELEASE_ID_INVALID', 500);
  const controlToken = enabled ? token || readToken(env.KISUNO_RELEASE_CONTROL_TOKEN_FILE) : '';
  const tokenHash = crypto.createHash('sha256').update(controlToken).digest();
  const lockOwner = releaseId + ':' + crypto.randomUUID();
  let state: ReleaseSnapshot['state'] = enabled ? 'standby' : 'active';
  let ready = false;
  let configured = false;
  let dependencies: ReleaseDependencies;
  let workersActive = false;
  let workerLockHeld = false;
  let workerLockRevision = 0;
  let workerFailure = false;
  let activityRevision = 0;
  let control: http.Server | undefined;
  let transition: Promise<unknown> = Promise.resolve();
  const requests = new Set<symbol>();
  const tasks = new Map<symbol, { worker: boolean }>();
  const workers = new Map<string, ReleaseWorker>();

  const bounded = <T>(operation: () => T | Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(fault('RELEASE_CHECK_TIMEOUT')), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = transition.then(operation);
    transition = pending.catch(() => {});
    return pending;
  };
  const runTask = async <T>(
    name: string,
    operation: () => T | Promise<T>,
    { worker = false }: { worker?: boolean } = {},
  ): Promise<T> => {
    if (!enabled) return operation();
    if (state === 'sealed') throw fault('RELEASE_SEALED');
    if (worker && !workersActive) throw fault('RELEASE_WORKERS_PAUSED');
    const key = Symbol(name);
    tasks.set(key, { worker });
    activityRevision++;
    try {
      if (worker) {
        try {
          if ((await bounded(() => dependencies.redis.get(WORKER_LOCK))) !== lockOwner)
            throw fault('RELEASE_WORKER_LOCK_CHANGED');
        } catch (error) {
          await invalidateWorkerOwnership();
          throw error;
        }
        if (!workersActive) throw fault('RELEASE_WORKERS_PAUSED');
      }
      return await operation();
    } finally {
      tasks.delete(key);
      activityRevision++;
    }
  };
  const invalidateWorkerOwnership = async () => {
    workerFailure = true;
    workersActive = false;
    await Promise.allSettled([...workers.values()].map((worker) => bounded(worker.stop)));
  };
  const workerTasks = () => [...tasks.values()].filter((task) => task.worker).length;
  const releaseWorkerLock = async () => {
    if (!workerLockHeld || workersActive || workerTasks() !== 0) return;
    if (workerFailure) throw fault('RELEASE_WORKER_STATE_UNKNOWN');
    const lockRevision = workerLockRevision;
    const removed = await bounded(() =>
      dependencies.redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        WORKER_LOCK,
        lockOwner,
      ),
    );
    if (!workerLockHeld || lockRevision !== workerLockRevision) return;
    if (removed !== 1) throw fault('RELEASE_WORKER_LOCK_CHANGED');
    workerLockHeld = false;
    workerLockRevision++;
  };
  const pauseWorkers = async () => {
    workersActive = false;
    const stopped = await Promise.allSettled(
      [...workers.values()].map((worker) => Promise.resolve().then(worker.stop)),
    );
    if (stopped.some((result) => result.status === 'rejected')) {
      workerFailure = true;
      throw fault('RELEASE_WORKER_PAUSE_FAILED');
    }
    await releaseWorkerLock();
  };
  const snapshot = async (): Promise<ReleaseSnapshot> => {
    const observedRevision = activityRevision;
    const blockers = [];
    let redisReady = false;
    let generation = { jobs: 0, pending: 0, paused: 0 };
    if (!configured || !ready) blockers.push('RELEASE_NOT_READY');
    if (configured) {
      try {
        redisReady = (await bounded(dependencies.checkRedis)) === true;
        if (!redisReady) blockers.push('RELEASE_REDIS_UNAVAILABLE');
      } catch {
        blockers.push('RELEASE_REDIS_UNAVAILABLE');
      }
      if (workerLockHeld && !workerFailure) {
        const lockRevision = workerLockRevision;
        try {
          const currentOwner = await bounded(() => dependencies.redis.get(WORKER_LOCK));
          if (workerLockHeld && lockRevision === workerLockRevision && currentOwner !== lockOwner) {
            await invalidateWorkerOwnership();
            blockers.push('RELEASE_WORKER_LOCK_CHANGED');
          }
        } catch {
          if (workerLockHeld && lockRevision === workerLockRevision) {
            await invalidateWorkerOwnership();
            blockers.push('RELEASE_WORKER_LOCK_CHANGED');
          }
        }
      }
      try {
        generation = await bounded(dependencies.generationSnapshot);
        if (
          !(['jobs', 'pending', 'paused'] as const).every(
            (key) => Number.isSafeInteger(generation[key]) && generation[key] >= 0,
          )
        )
          throw fault('RELEASE_INVALID_WORK_STATE');
      } catch {
        blockers.push('RELEASE_WORK_STATE_UNKNOWN');
      }
      if (!workersActive && workerLockHeld && workerTasks() === 0) {
        try {
          await releaseWorkerLock();
        } catch {
          blockers.push('RELEASE_WORKER_LOCK_CHANGED');
        }
      }
    }
    if (workerFailure) blockers.push('RELEASE_WORKER_STATE_UNKNOWN');
    const quiescent =
      observedRevision === activityRevision &&
      blockers.length === 0 &&
      !workersActive &&
      !workerLockHeld &&
      requests.size === 0 &&
      tasks.size === 0 &&
      generation.jobs === 0 &&
      generation.pending === 0 &&
      generation.paused === 0;
    return {
      contract: 1,
      releaseId,
      state,
      ready: ready && configured && blockers.length === 0,
      redisReady,
      workersActive,
      workerTasks: workerTasks(),
      requests: requests.size,
      tasks: tasks.size,
      ...generation,
      quiescent,
      blockers,
    };
  };
  const action = (name: string) =>
    serialize(async () => {
      if (name === 'activate') {
        if (state === 'sealed') throw fault('RELEASE_SEALED');
        const current = await snapshot();
        if (!current.ready || workerFailure) throw fault('RELEASE_NOT_READY');
        if (!workerLockHeld) {
          const claimed = await bounded(() => dependencies.redis.set(WORKER_LOCK, lockOwner, 'NX'));
          if (
            claimed !== 'OK' &&
            (await bounded(() => dependencies.redis.get(WORKER_LOCK))) !== lockOwner
          )
            throw fault('RELEASE_WORKERS_OWNED_ELSEWHERE');
          workerLockHeld = true;
          workerLockRevision++;
        }
        try {
          if (!workersActive) {
            workersActive = true;
            for (const worker of workers.values()) await worker.start();
          }
          state = 'active';
        } catch {
          workerFailure = true;
          await pauseWorkers().catch(() => {});
          throw fault('RELEASE_ACTIVATION_FAILED');
        }
      } else if (name === 'pause-workers') {
        if (!['standby', 'active', 'draining'].includes(state)) throw fault('RELEASE_NOT_ACTIVE');
        await pauseWorkers();
      } else if (name === 'drain') {
        if (!['standby', 'active', 'draining'].includes(state)) throw fault('RELEASE_NOT_ACTIVE');
        state = 'draining';
        await pauseWorkers();
      } else if (name === 'seal') {
        if (state === 'sealed') return snapshot();
        if (state !== 'draining') throw fault('RELEASE_NOT_DRAINING');
        const sealRevision = activityRevision;
        const current = await snapshot();
        if (sealRevision !== activityRevision || !current.quiescent)
          throw fault('RELEASE_STILL_BUSY');
        // No await between the final local admission check and sealing.
        if (requests.size || tasks.size || workersActive || workerLockHeld)
          throw fault('RELEASE_STILL_BUSY');
        state = 'sealed';
      } else throw fault('RELEASE_ACTION_UNKNOWN', 404);
      return snapshot();
    });
  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || ['/health', '/livez', '/readyz'].includes(req.path)) return next();
    if (/^\/api\/assistants\/v[12]\/chat(?:\/|$)/.test(req.path)) {
      res.status(503).json({
        code: 'RELEASE_ADAPTER_UNSUPPORTED',
        error:
          'Dieser ältere Assistant-Adapter unterstützt keine unterbrechungsfreien Updates. Bitte verwende den Agenten-Chat.',
      });
      return;
    }
    if (state !== 'active') {
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        code: 'RELEASE_NOT_ACCEPTING',
        error: 'Diese Version nimmt keine neuen Anfragen an.',
      });
      return;
    }
    const key = Symbol('request');
    requests.add(key);
    activityRevision++;
    const done = () => {
      if (requests.delete(key)) activityRevision++;
      res.off('finish', done);
      res.off('close', done);
    };
    res.once('finish', done);
    res.once('close', done);
    next();
  };
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const supplied = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const actual = crypto
      .createHash('sha256')
      .update(supplied.replace(/^Bearer /, ''))
      .digest();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (!supplied.startsWith('Bearer ') || !crypto.timingSafeEqual(actual, tokenHash)) {
      res.writeHead(401);
      res.end(JSON.stringify({ code: 'RELEASE_UNAUTHORIZED' }));
      return;
    }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) {
      res.writeHead(400);
      res.end(JSON.stringify({ code: 'RELEASE_BODY_NOT_ALLOWED' }));
      return;
    }
    try {
      const url = req.url || '';
      if (!url.startsWith(PREFIX) || url.includes('?')) throw fault('RELEASE_ACTION_UNKNOWN', 404);
      const name = url.slice(PREFIX.length);
      let result: unknown;
      if (name === 'status' && req.method === 'GET') result = await snapshot();
      else if (req.method === 'POST') result = await action(name);
      else throw fault('RELEASE_METHOD_NOT_ALLOWED', 405);
      res.end(JSON.stringify(result));
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      res.writeHead(failure.status || 409);
      res.end(JSON.stringify({ code: failure.code || 'RELEASE_CONTROL_FAILED' }));
    }
  };
  return {
    enabled,
    releaseId,
    get state() {
      return state;
    },
    get workersActive() {
      return workersActive;
    },
    runTask,
    snapshot,
    action,
    middleware,
    configure(value: ReleaseDependencies) {
      if (
        configured ||
        !value ||
        typeof value.checkRedis !== 'function' ||
        typeof value.generationSnapshot !== 'function' ||
        !value.redis
      )
        throw fault('RELEASE_CONFIGURATION_INVALID');
      dependencies = value;
      configured = true;
    },
    registerWorker(name: string, worker: ReleaseWorker) {
      if (
        ready ||
        workers.has(name) ||
        typeof worker.start !== 'function' ||
        typeof worker.stop !== 'function'
      )
        throw fault('RELEASE_WORKER_REGISTRATION_INVALID');
      workers.set(name, worker);
    },
    markReady() {
      ready = true;
    },
    verifyBuild(directory: string) {
      if (!enabled) return;
      const fd = fs.openSync(
        path.join(directory, 'release-contract.json'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) throw fault('RELEASE_BUILD_CONTRACT_INVALID');
        const contract = JSON.parse(fs.readFileSync(fd, 'utf8')) as {
          schemaVersion?: number;
          managed?: boolean;
          pwaEnabled?: boolean;
          autoReload?: boolean;
        };
        if (
          contract.schemaVersion !== 1 ||
          contract.managed !== true ||
          contract.pwaEnabled !== false ||
          contract.autoReload !== false
        )
          throw fault('RELEASE_BUILD_CONTRACT_INVALID');
      } finally {
        fs.closeSync(fd);
      }
    },
    async startControl({ host = '0.0.0.0', port = 3091 }: { host?: string; port?: number } = {}) {
      if (!enabled || control) return control;
      control = http.createServer((req, res) => {
        void handler(req, res);
      });
      control.headersTimeout = 5000;
      control.requestTimeout = 5000;
      control.keepAliveTimeout = 1000;
      const server = control;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return control;
    },
  };
}

export const releaseLifecycle: ReleaseLifecycle = createReleaseLifecycle();
