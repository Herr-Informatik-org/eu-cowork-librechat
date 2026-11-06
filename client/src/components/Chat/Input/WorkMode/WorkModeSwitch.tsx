import { memo, useEffect, useId } from 'react';
import * as Ariakit from '@ariakit/react';
import { Check, ChevronDown } from 'lucide-react';
import { EModelEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { WorkMode } from 'librechat-data-provider';
import { useWorkMode, setWorkMode, adoptNewConversationMode } from './store';
import { useGetEndpointsQuery } from '~/data-provider';
import { WORK_MODE_OPTIONS } from './options';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const BUTTON_CLASS =
  'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy aria-expanded:bg-surface-hover';
const MENU_CLASS =
  'kisuno-work-mode-menu z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border-light bg-surface-secondary p-1.5 text-text-primary shadow-lg outline-none';
const ITEM_CLASS =
  'flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none data-[active-item]:bg-surface-tertiary';

/**
 * Planen / Fragen / Auto under the composer. Shown only when the server enforces
 * work modes (`endpoints.agents.toolApproval.workModes`); the choice is kept per
 * conversation and sent with every request. Number keys 1 to 3 pick a mode while
 * the menu is open.
 */
function WorkModeSwitch({
  conversationId,
  endpoint,
}: {
  conversationId: string;
  endpoint?: string | null;
}) {
  const localize = useLocalize();
  const descriptionPrefix = useId();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const serverDefault = endpointsConfig?.[EModelEndpoint.agents]?.workModes?.default;
  const stored = useWorkMode(conversationId);
  const menu = Ariakit.useMenuStore({ placement: 'top-start' });

  useEffect(() => {
    adoptNewConversationMode(conversationId);
  }, [conversationId]);

  if (serverDefault == null || (endpoint != null && isAssistantsEndpoint(endpoint))) {
    return null;
  }

  const current = stored ?? serverDefault;
  const active =
    WORK_MODE_OPTIONS.find((option) => option.mode === current) ?? WORK_MODE_OPTIONS[2];
  const choose = (mode: WorkMode) => {
    setWorkMode(conversationId, mode);
    menu.hide();
  };

  return (
    <>
      <Ariakit.MenuButton
        store={menu}
        className={BUTTON_CLASS}
        aria-label={`${localize('com_ui_work_mode')}: ${localize(active.label)}`}
        data-testid="work-mode-button"
      >
        <active.Icon className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{localize(active.label)}</span>
        <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
      </Ariakit.MenuButton>
      <Ariakit.Menu
        store={menu}
        portal
        gutter={6}
        className={MENU_CLASS}
        aria-label={localize('com_ui_work_mode')}
        onKeyDown={(event) => {
          const option = WORK_MODE_OPTIONS[Number(event.key) - 1];
          if (option != null) {
            event.preventDefault();
            choose(option.mode);
          }
        }}
      >
        {WORK_MODE_OPTIONS.map((option, index) => {
          const selected = option.mode === current;
          const descriptionId = `${descriptionPrefix}-${option.mode}`;
          return (
            <Ariakit.MenuItem
              key={option.mode}
              role="menuitemradio"
              aria-checked={selected}
              aria-describedby={descriptionId}
              className={ITEM_CLASS}
              onClick={() => choose(option.mode)}
            >
              <option.Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {localize(option.label)}
                  {option.mode === serverDefault && (
                    <span className="ml-1.5 text-xs font-normal text-text-secondary">
                      {localize('com_ui_work_mode_default')}
                    </span>
                  )}
                </span>
                <span id={descriptionId} className="text-xs text-text-secondary">
                  {localize(option.description)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
                <Check
                  className={cn('h-4 w-4', selected ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                <kbd className="font-sans" aria-hidden="true">
                  {index + 1}
                </kbd>
              </span>
            </Ariakit.MenuItem>
          );
        })}
      </Ariakit.Menu>
    </>
  );
}

export default memo(WorkModeSwitch);
