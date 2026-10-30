import { useRef, useState, useSyncExternalStore } from 'react';
import { v4 } from 'uuid';
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
