import type { LocalFolderRequest, LocalFolderResult } from 'librechat-data-provider';

export interface FolderInput {
  id: string;
  label: string;
  handle?: FileSystemDirectoryHandle;
  files?: File[];
}

export interface FolderReader {
  execute(request: LocalFolderRequest, signal?: AbortSignal): Promise<LocalFolderResult>;
  dispose(): void;
}

/** A dedicated worker keeps parsing and large-directory traversal off the UI thread. */
export function createFolderReader(input: FolderInput): FolderReader {
  let worker: Worker | undefined;
  let disposed = false;
  let running = false;
  let sequence = 0;
  let cancel: (() => void) | undefined;
  const stop = () => {
    worker?.terminate();
    worker = undefined;
  };
  return {
    async execute(request, signal) {
      if (disposed || signal?.aborted) {
        throw new DOMException('Ordnerzugriff beendet.', 'AbortError');
      }
      if (running) {
        throw new Error('Für diesen Ordner läuft bereits eine Abfrage.');
      }
      if (request.folderId !== input.id) {
        throw new Error('Dieser Ordner ist nicht freigegeben.');
      }
      running = true;
      try {
        if (!worker) {
          worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
          worker.postMessage({ type: 'init', input });
        }
        const currentWorker = worker;
        const requestId = ++sequence;
        return await new Promise<LocalFolderResult>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            currentWorker.onmessage = null;
            currentWorker.onerror = null;
            cancel = undefined;
          };
          const abort = () => {
            cleanup();
            stop();
            reject(
              new DOMException(
                'Ordnerabfrage abgebrochen. Bitte bei Bedarf neu starten.',
                'AbortError',
              ),
            );
          };
          cancel = abort;
          signal?.addEventListener('abort', abort, { once: true });
          currentWorker.onerror = () => {
            cleanup();
            stop();
            reject(new Error('Lokale Verarbeitung fehlgeschlagen. Bitte Abfrage neu starten.'));
          };
          currentWorker.onmessage = (
            event: MessageEvent<{ type: string; requestId: number; result: LocalFolderResult }>,
          ) => {
            if (event.data?.type !== 'local-folder-result' || event.data.requestId !== requestId)
              return;
            try {
              if (
                !event.data.result ||
                typeof event.data.result !== 'object' ||
                typeof event.data.result.coverage?.complete !== 'boolean'
              ) {
                throw new Error('Die lokale Verarbeitung hat kein gültiges Ergebnis geliefert.');
              }
              if (JSON.stringify(event.data.result).length > request.maxChars) {
                throw new Error('Das lokale Ergebnis überschreitet das erlaubte Kontextbudget.');
              }
              cleanup();
              resolve(event.data.result);
            } catch (error) {
              cleanup();
              stop();
              reject(error instanceof Error ? error : new Error('Ungültiges lokales Ergebnis.'));
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            stop();
            reject(
              new Error(
                'Zeitgrenze erreicht. Bitte einen kleineren Unterordner oder eine konkrete Datei wählen. Nicht vollständig geprüft.',
              ),
            );
          }, 30_000);
          try {
            currentWorker.postMessage({ type: 'execute', requestId, request });
          } catch {
            cleanup();
            stop();
            reject(
              new Error('Ordnerdaten konnten nicht an die lokale Verarbeitung übergeben werden.'),
            );
          }
        });
      } catch (error) {
        stop();
        throw error;
      } finally {
        running = false;
      }
    },
    dispose() {
      disposed = true;
      cancel?.();
      stop();
    },
  };
}
