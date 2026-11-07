import { createFolderEngine } from './engine';
import type { FolderInput } from './reader';
import type { LocalFolderRequest } from 'librechat-data-provider';

let engine: ReturnType<typeof createFolderEngine> | undefined;
self.onmessage = async (
  event: MessageEvent<
    | { type: 'init'; input: FolderInput }
    | { type: 'execute'; requestId: number; request: LocalFolderRequest }
  >,
) => {
  if (event.data.type === 'init') {
    engine = createFolderEngine(event.data.input);
    return;
  }
  if (engine && event.data.type === 'execute' && Number.isInteger(event.data.requestId)) {
    self.postMessage({
      type: 'local-folder-result',
      requestId: event.data.requestId,
      result: await engine.execute(event.data.request),
    });
  }
};
