import type {
  LocalFolderGrant,
  LocalFolderRequest,
  LocalFolderResult,
  TEphemeralAgent,
} from 'librechat-data-provider';

export interface FolderReader {
  execute(request: LocalFolderRequest, signal?: AbortSignal): Promise<LocalFolderResult>;
  dispose(): void;
}

export type FolderStatus = 'ready' | 'reading' | 'error';
export type FolderView = LocalFolderGrant & { status: FolderStatus };
type StoredFolder = FolderView & { reader: FolderReader; controller: AbortController };

const conversations = new Map<string, Map<string, StoredFolder>>();
const listeners = new Set<() => void>();
const resetListeners = new Set<(folderId?: string) => void>();
let owner: string | null = null;
let revision = 0;
let session = 0;

export const folderConversationKey = (id?: string | null) => id || 'new';
export const getLocalFolderRevision = () => revision;
export const getLocalFolderSession = () => session;
export const isLocalFolderUser = (userId?: string | null) => !!userId && owner === userId;
export const subscribeLocalFolders = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const onLocalFolderReset = (listener: (folderId?: string) => void) => {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
};
export function notifyLocalFolders() {
  revision++;
  listeners.forEach((listener) => listener());
}

function disposeFolder(folder: StoredFolder) {
  folder.controller.abort();
  folder.reader.dispose();
}

/** Handles and extracted data never enter Recoil, storage, or the server payload. */
export function setLocalFolderUser(userId?: string | null) {
  const next = userId || null;
  if (next === owner) return;
  conversations.forEach((folders) => folders.forEach(disposeFolder));
  conversations.clear();
  owner = next;
  session++;
  resetListeners.forEach((listener) => listener());
  notifyLocalFolders();
}

export function clearLocalFolders() {
  conversations.forEach((folders) => folders.forEach(disposeFolder));
  conversations.clear();
  session++;
  resetListeners.forEach((listener) => listener());
  notifyLocalFolders();
}

export function getLocalFolders(
  userId?: string | null,
  conversationId?: string | null,
): FolderView[] {
  if (!isLocalFolderUser(userId)) return [];
  return [...(conversations.get(folderConversationKey(conversationId))?.values() ?? [])].map(
    ({ id, label, status }) => ({ id, label, status }),
  );
}

export function getLocalFolderCount(userId?: string | null): number {
  if (!isLocalFolderUser(userId)) return 0;
  return [...conversations.values()].reduce((total, folders) => total + folders.size, 0);
}

export function addLocalFolder(
  userId: string,
  conversationId: string,
  grant: LocalFolderGrant,
  reader: FolderReader,
  expectedSession = session,
): boolean {
  const key = folderConversationKey(conversationId);
  const folders = conversations.get(key) ?? new Map<string, StoredFolder>();
  if (
    !isLocalFolderUser(userId) ||
    expectedSession !== session ||
    folders.size >= 3 ||
    getLocalFolderCount(userId) >= 12 ||
    folders.has(grant.id)
  ) {
    reader.dispose();
    return false;
  }
  folders.set(grant.id, { ...grant, reader, status: 'ready', controller: new AbortController() });
  conversations.set(key, folders);
  notifyLocalFolders();
  return true;
}

export function removeLocalFolder(userId: string, conversationId: string, id: string) {
  if (!isLocalFolderUser(userId)) return;
  const folders = conversations.get(folderConversationKey(conversationId));
  const folder = folders?.get(id);
  if (!folder) return;
  disposeFolder(folder);
  folders?.delete(id);
  resetListeners.forEach((listener) => listener(id));
  notifyLocalFolders();
}

/** Transfer only grants captured by the acknowledged first submission. */
export function transferLocalFolders(userId: string, destination: string, ids: string[]) {
  if (!isLocalFolderUser(userId) || !destination || destination === 'new') return;
  const source = conversations.get('new');
  if (!source) return;
  const target = conversations.get(destination) ?? new Map<string, StoredFolder>();
  for (const id of ids) {
    const folder = source.get(id);
    if (!folder || target.size >= 3 || target.has(id)) continue;
    source.delete(id);
    target.set(id, folder);
  }
  conversations.set(destination, target);
  notifyLocalFolders();
}

export function withLocalFolders(
  ephemeral: TEphemeralAgent | null | undefined,
  userId: string | null | undefined,
  conversationId: string | null | undefined,
  enabled: boolean,
): TEphemeralAgent | null {
  const { localFolders: _stale, ...rest } = ephemeral ?? {};
  const grants = enabled
    ? getLocalFolders(userId, conversationId).map(({ id, label }) => ({ id, label }))
    : [];
  if (grants.length) return { ...rest, localFolders: grants };
  return Object.keys(rest).length ? rest : null;
}

export async function executeLocalFolder(
  userId: string,
  conversationId: string,
  request: LocalFolderRequest,
  signal?: AbortSignal,
): Promise<LocalFolderResult> {
  const folder = conversations.get(conversationId)?.get(request.folderId);
  if (!isLocalFolderUser(userId) || !folder || signal?.aborted) {
    throw new Error(
      'Der lokale Ordner ist nicht mehr verbunden. Bitte erneut verbinden und die Anfrage wiederholen.',
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  folder.controller.signal.addEventListener('abort', abort, { once: true });
  folder.status = 'reading';
  notifyLocalFolders();
  try {
    const result = await folder.reader.execute(request, controller.signal);
    if (
      controller.signal.aborted ||
      !isLocalFolderUser(userId) ||
      conversations.get(conversationId)?.get(request.folderId) !== folder
    ) {
      throw new Error('Der lokale Ordnerzugriff wurde beendet.');
    }
    folder.status = 'ready';
    return result;
  } catch (error) {
    folder.status = controller.signal.aborted ? 'ready' : 'error';
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    folder.controller.signal.removeEventListener('abort', abort);
    notifyLocalFolders();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', clearLocalFolders);
}
