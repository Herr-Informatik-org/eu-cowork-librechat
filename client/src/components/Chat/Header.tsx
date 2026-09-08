import { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { PanelRight } from 'lucide-react';
import { useMediaQuery } from '@librechat/client';
import { getConfigDefaults, PermissionTypes, Permissions } from 'librechat-data-provider';
import ModelSelector from './Menus/Endpoints/ModelSelector';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import { OpenSidebar, PresetsMenu } from './Menus';
import BookmarkMenu from './Menus/BookmarkMenu';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { useHasAccess, useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import { useSessionVisibility } from '~/components/SidePanel/Session/state';

const defaultInterface = getConfigDefaults().interface;

function Header() {
  const localize = useLocalize();
  const { contextVisible, toggleContext } = useSessionVisibility();
  const { data: startupConfig } = useGetStartupConfig();
  const navVisible = useRecoilValue(store.sidebarExpanded);

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  return (
    <div className="absolute top-0 z-10 flex h-[52px] w-full items-center justify-between border-b border-border-light bg-presentation p-2 font-semibold text-text-primary">
      <div className="hide-scrollbar flex w-full items-center justify-between gap-2 overflow-x-auto">
        <div className="mx-1 flex items-center">
          {isSmallScreen ? <OpenSidebar /> : null}
          {!(navVisible && isSmallScreen) && (
            <div
              className={cn(
                'flex items-center gap-2 pl-2',
                !isSmallScreen ? 'transition-all duration-200 ease-in-out' : '',
              )}
            >
              <ModelSelector startupConfig={startupConfig} />
              {interfaceConfig.presets === true && interfaceConfig.modelSelect && <PresetsMenu />}
              {hasAccessToBookmarks === true && <BookmarkMenu />}
              {hasAccessToMultiConvo === true && <AddMultiConvo />}
              {isSmallScreen && (
                <>
                  <ExportAndShareMenu
                    isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
                  />
                  {hasAccessToTemporaryChat === true && <TemporaryChat />}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={localize('com_ui_session_workspace')}
            aria-pressed={contextVisible}
            title={localize('com_ui_session_workspace')}
            onClick={toggleContext}
            className="rounded-lg p-2 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
          >
            <PanelRight className="size-5" aria-hidden="true" />
          </button>
          {!isSmallScreen && (
            <>
              <ExportAndShareMenu
                isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
              />
              {hasAccessToTemporaryChat === true && <TemporaryChat />}
            </>
          )}
        </div>
      </div>
      {/* Empty div for spacing */}
      <div />
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'Header';

export default MemoizedHeader;
