import { useId, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { DropdownPopup } from '@librechat/client';
import { Check, ChevronDown, CircleAlert, FolderOpen, LoaderCircle } from 'lucide-react';
import type { MenuItemProps } from '~/common';
import { useAuthContext } from '~/hooks/AuthContext';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { folderConversationKey, removeLocalFolder } from './store';
import { useFolderPicker, useLocalFolders } from './useFolders';

export default function LocalFolderMenu({
  conversationId,
  available = true,
}: {
  conversationId?: string | null;
  available?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const folders = useLocalFolders(conversationId);
  const picker = useFolderPicker(conversationId);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  if (startupConfig?.localFoldersEnabled !== true || !user?.id) return null;
  if (!available && !folders.length) return null;

  const label = folders[0]?.label ?? localize('com_ui_local_folders_none');
  const reading = folders.some((folder) => folder.status === 'reading');
  const error = folders.some((folder) => folder.status === 'error');
  let status = '';
  let StatusIcon = FolderOpen;
  if (error) {
    status = localize('com_ui_local_folders_error');
    StatusIcon = CircleAlert;
  }
  if (reading) {
    status = localize('com_ui_local_folders_reading');
    StatusIcon = LoaderCircle;
  }
  const items: MenuItemProps[] = [
    {
      label: localize('com_ui_local_folders_none'),
      render: (props) => (
        <div {...props}>
          <span>{localize('com_ui_local_folders_none')}</span>
          {!folders.length && <Check className="ml-auto size-4 text-blue-500" aria-hidden="true" />}
        </div>
      ),
      ariaChecked: folders.length === 0,
      onClick: () => {
        for (const folder of folders) {
          removeLocalFolder(user.id, folderConversationKey(conversationId), folder.id);
        }
      },
    },
  ];
  if (folders.length) {
    items.push({ separate: true });
    for (const folder of folders) {
      items.push({
        id: `${menuId}-${folder.id}`,
        ariaLabel: `${localize('com_ui_local_folders_disconnect')}: ${folder.label}`,
        ariaChecked: true,
        label: folder.label,
        render: (props) => (
          <div {...props}>
            <span className="min-w-0 truncate" title={folder.label}>
              {folder.label}
            </span>
            <Check className="ml-auto size-4 shrink-0 text-blue-500" aria-hidden="true" />
          </div>
        ),
        onClick: () => removeLocalFolder(user.id, folderConversationKey(conversationId), folder.id),
      });
    }
  }
  if (available) {
    items.push(
      { separate: true },
      { label: localize('com_ui_local_folders_open'), onClick: () => void picker.connect() },
    );
  }

  return (
    <>
      {picker.input}
      <DropdownPopup
        menuId={menuId}
        isOpen={open}
        setIsOpen={setOpen}
        focusLoop={true}
        portal={true}
        unmountOnHide={true}
        className="w-56 max-w-[calc(100vw-2rem)]"
        itemClassName="min-w-0"
        items={items}
        trigger={
          <Ariakit.MenuButton
            data-testid="local-folder-menu-button"
            aria-label={`${localize('com_ui_local_folders_select')}: ${label}`}
            className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <StatusIcon
              className={reading ? 'size-4 shrink-0 animate-spin' : 'size-4 shrink-0'}
              aria-hidden="true"
            />
            <span className="max-w-40 truncate" title={label}>
              {label}
            </span>
            {folders.length > 1 && <span>+{folders.length - 1}</span>}
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          </Ariakit.MenuButton>
        }
      />
      <span role="status" className="sr-only">
        {status}
      </span>
      {picker.message && (
        <span role="status" className="text-xs text-text-secondary">
          {picker.message}
        </span>
      )}
    </>
  );
}
