import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, FolderCheck } from 'lucide-react';
import type { MailWorkspaceFolder } from 'librechat-data-provider';
import { useMailFolders } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';

export function FolderPicker({
  active,
  chosen,
  onChoose,
  onClose,
}: {
  active: boolean;
  chosen: MailWorkspaceFolder | null;
  onChoose: (folder: MailWorkspaceFolder) => void;
  onClose: () => void;
}) {
  const t = useLocalize();
  const [parents, setParents] = useState<MailWorkspaceFolder[]>([]);
  const folders = useMailFolders(active, parents.at(-1)?.id);
  return (
    <div className="mail-folder-picker" role="dialog" aria-label={t('com_ui_mail_choose_folder')}>
      <div className="mail-settings-heading">
        <h3>{t('com_ui_mail_choose_folder')}</h3>
        <button className="mail-button" onClick={onClose}>
          {t('com_ui_mail_close')}
        </button>
      </div>
      <p className="mail-muted">{t('com_ui_mail_folder_hint')}</p>
      <div className="mail-folder-path">
        <button
          className="mail-button"
          disabled={!parents.length}
          onClick={() => setParents((old) => old.slice(0, -1))}
        >
          <ArrowLeft size={15} />
          {t('com_ui_mail_back')}
        </button>
        <span>{parents.map((p) => p.displayName).join(' / ') || t('com_ui_mail_mailbox')}</span>
      </div>
      {folders.isLoading ? (
        <p role="status">{t('com_ui_mail_loading')}</p>
      ) : (
        <ul>
          {folders.data?.folders.map((folder) => (
            <li key={folder.id}>
              <button
                className="mail-folder-name"
                disabled={!folder.canMoveTo}
                onClick={() => {
                  onChoose({
                    ...folder,
                    path: [...parents.map((p) => p.displayName), folder.displayName].join(' / '),
                  });
                  onClose();
                }}
              >
                <FolderCheck size={16} />
                {folder.displayName}
                {chosen?.id === folder.id && <Check size={15} />}
              </button>
              {!!folder.childFolderCount && (
                <button
                  className="mail-button"
                  title={t('com_ui_mail_subfolders')}
                  aria-label={`${folder.displayName}: ${t('com_ui_mail_subfolders')}`}
                  onClick={() => setParents((old) => [...old, folder])}
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {folders.isError && (
        <p className="mail-error" role="alert">
          {t('com_ui_mail_error')}
        </p>
      )}
    </div>
  );
}

export function useDoneFolder(owner?: string, mailbox?: string) {
  const key = owner && mailbox ? `mail:done-folder:${owner}:${mailbox}` : '';
  const [stored, setStored] = useState<{ key: string; folder: MailWorkspaceFolder | null }>({
    key: '',
    folder: null,
  });
  useEffect(() => {
    let folder: MailWorkspaceFolder | null = null;
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null') as MailWorkspaceFolder | null;
      if (value?.id && value.displayName && value.canMoveTo) folder = value;
    } catch {
      folder = null;
    }
    setStored({ key, folder });
  }, [key]);
  const chooseFolder = (folder: MailWorkspaceFolder) => {
    if (!key) return;
    setStored({ key, folder });
    try {
      localStorage.setItem(key, JSON.stringify(folder));
    } catch {
      /* The choice remains usable in memory when browser storage is unavailable. */
    }
  };
  return { folder: stored.key === key ? stored.folder : null, chooseFolder };
}
