import { useRef, useState, useSyncExternalStore } from 'react';
import { v4 } from 'uuid';
import { FolderOpen, X } from 'lucide-react';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import { createFolderReader } from './reader';
import {
  addLocalFolder,
  folderConversationKey,
  getLocalFolderRevision,
  getLocalFolderSession,
  getLocalFolderCount,
  getLocalFolders,
  removeLocalFolder,
  subscribeLocalFolders,
} from './store';

export function useLocalFolders(conversationId?: string | null) {
  const { user } = useAuthContext();
  useSyncExternalStore(subscribeLocalFolders, getLocalFolderRevision, getLocalFolderRevision);
  return getLocalFolders(user?.id, conversationId);
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'read' }) => Promise<FileSystemDirectoryHandle>;
};

export function useFolderPicker(conversationId?: string | null) {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef<{ userId: string; conversationId: string; session: number }>();
  const [message, setMessage] = useState('');
  const folders = useLocalFolders(conversationId);

  const connect = async () => {
    if (!user?.id) return;
    if (folders.length >= 3) {
      setMessage(localize('com_ui_local_folders_limit'));
      return;
    }
    if (getLocalFolderCount(user.id) >= 12) {
      setMessage(localize('com_ui_local_folders_tab_limit'));
      return;
    }
    setMessage('');
    const selection = {
      userId: user.id,
      conversationId: folderConversationKey(conversationId),
      session: getLocalFolderSession(),
    };
    selectionRef.current = selection;
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) {
      inputRef.current?.click();
      return;
    }
    try {
      const handle = await picker.call(window, { mode: 'read' });
      const grant = {
        id: v4(),
        label: handle.name.slice(0, 120) || localize('com_ui_local_folder'),
      };
      const reader = createFolderReader({ ...grant, handle });
      if (
        !addLocalFolder(
          selection.userId,
          selection.conversationId,
          grant,
          reader,
          selection.session,
        )
      ) {
        setMessage(localize('com_ui_local_folders_changed'));
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage(localize('com_ui_local_folders_picker_failed'));
      }
    }
  };

  const input = (
    <input
      ref={(element) => {
        inputRef.current = element;
        element?.setAttribute('webkitdirectory', '');
      }}
      type="file"
      multiple
      hidden
      aria-label={localize('com_ui_local_folders_connect')}
      onChange={(event) => {
        const selection = selectionRef.current;
        if ((event.target.files?.length ?? 0) > 20000) {
          event.target.value = '';
          setMessage(localize('com_ui_local_folders_fallback_limit'));
          return;
        }
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (!selection || !files.length) return;
        // The fallback retains File objects, without reading or uploading their contents.
        const label = files[0].webkitRelativePath.split('/')[0] || localize('com_ui_local_folder');
        const grant = { id: v4(), label: label.slice(0, 120) };
        const reader = createFolderReader({ ...grant, files });
        if (
          !addLocalFolder(
            selection.userId,
            selection.conversationId,
            grant,
            reader,
            selection.session,
          )
        ) {
          setMessage(localize('com_ui_local_folders_changed'));
        }
      }}
    />
  );
  return { connect, input, message };
}

export function LocalFolderBadges({ conversationId }: { conversationId?: string | null }) {
  const folders = useLocalFolders(conversationId);
  const { user } = useAuthContext();
  const localize = useLocalize();
  if (!folders.length) return null;
  return (
    <>
      {folders.map((folder) => (
        <div
          key={folder.id}
          className="flex max-w-full items-center gap-1 rounded-full border border-border-light px-2 py-1 text-xs"
        >
          <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
          <span className="max-w-40 truncate" title={folder.label}>
            {folder.label}
          </span>
          <span role="status" className="text-text-secondary">
            {localize(
              {
                reading: 'com_ui_local_folders_reading',
                error: 'com_ui_local_folders_error',
                ready: 'com_ui_local_folders_ready',
              }[folder.status] as
                | 'com_ui_local_folders_reading'
                | 'com_ui_local_folders_error'
                | 'com_ui_local_folders_ready',
            )}
          </span>
          <button
            type="button"
            className="rounded p-1 hover:bg-surface-hover focus-visible:ring-2"
            aria-label={`${localize('com_ui_local_folders_disconnect')}: ${folder.label}`}
            onClick={() =>
              user?.id &&
              removeLocalFolder(user.id, folderConversationKey(conversationId), folder.id)
            }
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </div>
      ))}
      <p className="w-full px-1 text-xs text-text-secondary">
        {localize('com_ui_local_folders_hint')}
      </p>
    </>
  );
}
