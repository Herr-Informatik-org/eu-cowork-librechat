import { memo, useRef, useCallback, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { subscribeActivity, getConversationActivity } from '~/store/activity';
import useHeld from '~/components/Chat/Activity/useHeld';
import useSecondTick from '~/hooks/useSecondTick';
import { fontSizeAtom } from '~/store/fontSize';
import { formatElapsed } from '~/utils/elapsed';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import '~/components/Chat/Activity/activity.css';
import './thoughts.css';

const LABEL_HOLD_MS = 650;
const SHOW_ELAPSED_AFTER_MS = 2_000;
const LONG_WAIT_MS = 15_000;

/**
 * Before the server has accepted the generation the request is still being
 * prepared; afterwards the model request is under way, so the slot says it is
 * thinking and grows patient instead of inventing progress.
 */
export function pendingLabel(accepted: boolean, elapsedMs: number): TranslationKeys {
  if (!accepted) {
    return 'com_ui_response_preparing';
  }
  return elapsedMs >= LONG_WAIT_MS ? 'com_ui_thinking_long' : 'com_ui_thinking';
}

/**
 * Status in the response slot until the first visible content arrives. Elapsed
 * time counts from the moment the request was sent, so a remount when the
 * server confirms the message does not restart it.
 */
function PendingResponse({ conversationId }: { conversationId?: string | null }) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const key = conversationId || Constants.NEW_CONVO;
  const accepted = useRecoilValue(store.activeGenerationCreatedAtByConvoId(key)) != null;
  const activity = useSyncExternalStore(
    subscribeActivity,
    useCallback(() => getConversationActivity(key), [key]),
    () => null,
  );
  const mountedAtRef = useRef(Date.now());
  useSecondTick(true);

  const running = activity?.state === 'waiting' || activity?.state === 'running';
  const startedAt =
    running && activity != null
      ? Math.min(activity.startedAt, mountedAtRef.current)
      : mountedAtRef.current;
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const labelKey = useHeld(pendingLabel(accepted, elapsedMs), LABEL_HOLD_MS);

  return (
    <div
      className="kisuno-pending mb-2 pb-2 pt-2"
      data-testid="pending-response"
      data-phase={accepted ? 'started' : 'preparing'}
    >
      <div className={cn('flex min-w-0 items-center leading-[18px] text-text-secondary', fontSize)}>
        <span className="chat-activity-orbit mr-1.5" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="min-w-0 truncate">
          <span className="kisuno-shimmer">{localize(labelKey)}</span>
        </span>
        {elapsedMs >= SHOW_ELAPSED_AFTER_MS && (
          <span className="kisuno-elapsed ml-1.5 shrink-0" aria-hidden="true">
            {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(PendingResponse);
