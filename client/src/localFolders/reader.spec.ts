import { createFolderReader } from './reader';
import type { LocalFolderRequest, LocalFolderResult } from 'librechat-data-provider';

const result: LocalFolderResult = {
  status: 'ok',
  coverage: { complete: true, filesVisited: 1, filesRead: 1, bytesRead: 5, skipped: 0 },
  text: 'hello',
  source: { path: 'test.txt' },
};
const request: LocalFolderRequest = {
  folderId: 'folder',
  operation: 'read',
  path: 'test.txt',
  maxChars: 4000,
};
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failPost = false;
  onmessage: ((event: { data: object }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = jest.fn();
  posted: Array<{ type: string; requestId?: number }> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: { type: string; requestId?: number }) {
    if (FakeWorker.failPost && message.type === 'execute') throw new Error('clone failed');
    this.posted.push(message);
  }

  respond(value: object) {
    this.onmessage?.({ data: value });
  }

  finish() {
    this.respond({ type: 'local-folder-result', requestId: this.posted.at(-1)?.requestId, result });
  }
}
beforeEach(() => {
  jest.useFakeTimers();
  FakeWorker.instances = [];
  FakeWorker.failPost = false;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
});
afterEach(() => jest.useRealTimers());

it('ignores PDF-internal messages and stale request IDs', async () => {
  const reader = createFolderReader({ id: 'folder', label: 'Test', files: [] });
  const pending = reader.execute(request);
  const worker = FakeWorker.instances[0];
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  worker.respond({ sourceName: 'worker', targetName: 'main', action: 'ready', data: null });
  worker.respond({ type: 'local-folder-result', requestId: 0, result });
  await Promise.resolve();
  expect(resolved).toBe(false);
  worker.finish();
  expect(await pending).toEqual(result);
  const next = reader.execute(request);
  worker.respond({ type: 'local-folder-result', requestId: 1, result });
  worker.finish();
  expect(await next).toEqual(result);
  reader.dispose();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('terminates work on abort and rejects further access after disposal', async () => {
  const reader = createFolderReader({ id: 'folder', label: 'Test', files: [] });
  const controller = new AbortController();
  const pending = reader.execute(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  reader.dispose();
  await expect(reader.execute(request)).rejects.toHaveProperty('name', 'AbortError');
});

it('cleans up synchronous post failures before the next request', async () => {
  const reader = createFolderReader({ id: 'folder', label: 'Test', files: [] });
  FakeWorker.failPost = true;
  await expect(reader.execute(request)).rejects.toThrow('übergeben');
  expect(jest.getTimerCount()).toBe(0);
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  FakeWorker.failPost = false;
  const pending = reader.execute(request);
  FakeWorker.instances[1].finish();
  expect(await pending).toEqual(result);
  reader.dispose();
});

it('kills an overlong parser and never returns an oversized result', async () => {
  const reader = createFolderReader({ id: 'folder', label: 'Test', files: [] });
  const pending = reader.execute(request);
  jest.advanceTimersByTime(30001);
  await expect(pending).rejects.toThrow('Zeitgrenze');
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  const next = reader.execute(request);
  const worker = FakeWorker.instances[1];
  worker.respond({
    type: 'local-folder-result',
    requestId: worker.posted.at(-1)?.requestId,
    result: { ...result, text: 'x'.repeat(5000) },
  });
  await expect(next).rejects.toThrow('Kontextbudget');
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it('rejects malformed worker replies without leaving a pending promise', async () => {
  const reader = createFolderReader({ id: 'folder', label: 'Test', files: [] });
  const pending = reader.execute(request);
  const worker = FakeWorker.instances[0];
  worker.respond({ type: 'local-folder-result', requestId: worker.posted.at(-1)?.requestId });
  await expect(pending).rejects.toThrow('gültiges Ergebnis');
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
