import { memo, useCallback, useState, lazy, Suspense } from 'react';
import { useRecoilValue } from 'recoil';
import { ChevronDown, SlidersHorizontal, SquarePen } from 'lucide-react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton, Sidebar, Button, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { useLocalize, useNewConvo } from '~/hooks';
import { clearMessagesCache, cn } from '~/utils';
import SidePanelNav from '~/components/SidePanel/Nav';
import store from '~/store';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

const NewChatButton = memo(function NewChatButton({
  setActive,
  expanded,
}: {
  expanded: boolean;
  setActive: (id: string) => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { newConversation } = useNewConvo();
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const switchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        clearMessagesCache(queryClient, conversationId);
        queryClient.invalidateQueries([QueryKeys.messages]);
        newConversation();
        if (switchToHistory) {
          setActive(DEFAULT_PANEL);
        }
      }
    },
    [queryClient, conversationId, newConversation, switchToHistory, setActive],
  );

  return (
    <TooltipAnchor
      side="right"
      description={tooltipDescription}
      render={
        <a
          href="/c/new"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          aria-keyshortcuts={ariaKey}
          className={cn(
            'flex h-9 items-center gap-3 rounded-lg text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover',
            expanded ? 'w-full px-3' : 'w-9 justify-center',
          )}
          onClick={handleClick}
        >
          <SquarePen className="h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
          {expanded && <span>{localize('com_ui_new_chat')}</span>}
        </a>
      }
    />
  );
});

const NavActionButton = memo(function NavActionButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
}) {
  const localize = useLocalize();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        link.onClick(e);
        return;
      }
      setActive(link.id);
      if (!expanded) {
        onExpand?.();
      }
    },
    [link, setActive, expanded, onExpand],
  );

  return (
    <TooltipAnchor
      description={localize(link.title)}
      side="right"
      render={
        <Button
          variant="ghost"
          aria-label={localize(link.title)}
          aria-pressed={isActive}
          data-testid={`nav-panel-${link.id}`}
          className={cn(
            'h-9 rounded-lg text-sm font-normal',
            expanded ? 'w-full justify-start gap-3 px-3' : 'w-9 p-0',
            isActive ? 'bg-surface-active-alt text-text-primary' : 'text-text-secondary',
          )}
          onClick={handleClick}
        >
          <link.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {expanded && <span className="truncate">{localize(link.title)}</span>}
        </Button>
      }
    />
  );
});

function ExpandedPanel({
  links,
  expanded = true,
  onCollapse,
  onExpand,
}: {
  links: NavLink[];
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  const [toolsOpen, setToolsOpen] = useState(false);
  const primaryLinks = links.filter((link) => ['conversations', 'files'].includes(link.id));
  const toolLinks = links.filter((link) => !['conversations', 'files'].includes(link.id));

  const toggleLabel = expanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar';
  const toggleClick = expanded ? onCollapse : onExpand;
  const toggleSidebarHint = useShortcutHint('toggleSidebar', localize(toggleLabel));
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');

  return (
    <div className="workspace-nav flex h-full min-h-0 w-full flex-col border-r border-border-light bg-surface-primary-alt">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-3">
        {expanded && (
          <span className="min-w-0 flex-1 px-3 text-sm font-semibold tracking-tight text-text-primary">
            {localize('com_ui_nav_workspace')}
          </span>
        )}
        <TooltipAnchor
          side="right"
          description={toggleSidebarHint}
          render={
            <Button
              id={expanded ? CLOSE_SIDEBAR_ID : undefined}
              data-testid={expanded ? 'close-sidebar-button' : 'open-sidebar-button'}
              size="icon"
              variant="ghost"
              aria-label={localize(toggleLabel)}
              aria-expanded={expanded}
              aria-keyshortcuts={toggleSidebarAriaKey}
              className="h-9 w-9 shrink-0 rounded-lg"
              onClick={toggleClick}
            >
              <Sidebar aria-hidden="true" className="h-4 w-4 text-text-secondary" />
            </Button>
          }
        />
      </div>
      <nav aria-label={localize('com_ui_nav_actions')} className="shrink-0 space-y-0.5 px-2 pb-3">
        <NewChatButton setActive={setActive} expanded={expanded} />
        {primaryLinks.map((link) => (
          <NavActionButton
            key={link.id}
            link={link}
            isActive={link.id === effectiveActive}
            expanded={expanded}
            setActive={setActive}
            onExpand={onExpand}
          />
        ))}
        {toolLinks.length > 0 && (
          <>
            <Button
              variant="ghost"
              className={cn(
                'h-9 rounded-lg text-sm font-normal text-text-secondary',
                expanded ? 'w-full justify-start gap-3 px-3' : 'w-9 p-0',
              )}
              aria-label={localize('com_ui_nav_tools')}
              title={localize('com_ui_nav_tools')}
              aria-expanded={toolsOpen}
              aria-controls="workspace-nav-tools"
              onClick={() => {
                if (!expanded) onExpand?.();
                setToolsOpen((open) => !open);
              }}
            >
              <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
              {expanded && (
                <span className="min-w-0 flex-1 truncate text-left">
                  {localize('com_ui_nav_tools')}
                </span>
              )}
              {expanded && (
                <ChevronDown
                  className={cn('h-3.5 w-3.5', toolsOpen && 'rotate-180')}
                  aria-hidden="true"
                />
              )}
            </Button>
            {toolsOpen && expanded && (
              <div
                id="workspace-nav-tools"
                className="max-h-[30vh] space-y-0.5 overflow-y-auto pl-2"
              >
                {toolLinks.map((link) => (
                  <NavActionButton
                    key={link.id}
                    link={link}
                    isActive={link.id === effectiveActive}
                    expanded
                    setActive={(id) => {
                      setActive(id);
                      setToolsOpen(false);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </nav>
      {expanded && (
        <div
          className="min-h-0 flex-1 overflow-hidden border-t border-border-light pt-2"
          data-testid="workspace-nav-content"
        >
          <SidePanelNav links={links} />
        </div>
      )}
      <div className="mt-auto shrink-0 border-t border-border-light p-2">
        <Suspense fallback={<Skeleton className="h-9 w-full rounded-lg" />}>
          <AccountSettings collapsed={!expanded} />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
