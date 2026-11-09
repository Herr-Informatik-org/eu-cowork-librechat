import { memo } from 'react';
import type { ConversationActivity } from '~/store/activity';
import { useConversationActivity } from './useActivity';
import { isTerminalActivity } from '~/store/activity';
import { activityLabel } from './model';
import { activityIcons } from './icons';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import './activity.css';

const runningActivity = (conversationId: string): ConversationActivity => ({
  conversationId,
  runId: '',
  state: 'running',
  stage: 'thinking',
  startedAt: 0,
  updatedAt: 0,
});

/**
 * What a conversation row announces. A backend job (`active`) is authoritative for a run in
 * progress; without one, live observations are stale and outcomes stay until they are seen.
 */
export function badgeActivity(
  conversationId: string,
  observed: ConversationActivity | null,
  active?: boolean,
): ConversationActivity | null {
  if (active === true) {
    return observed && !isTerminalActivity(observed) ? observed : runningActivity(conversationId);
  }
  if (!observed) return null;
  if (isTerminalActivity(observed)) return observed.seen === true ? null : observed;
  if (observed.state === 'needs-input' || active === undefined) return observed;
  return null;
}

function ActivityStatusBadge({
  conversationId,
  compact = false,
  className,
  active,
}: {
  conversationId: string;
  compact?: boolean;
  className?: string;
  active?: boolean;
}) {
  const localize = useLocalize();
  const observed = useConversationActivity(conversationId);
  const activity = badgeActivity(conversationId, observed, active);
  if (!activity) return null;
  const label = localize(activityLabel(activity));
  const Icon = activityIcons[activity.state];
  return (
    <span
      className={cn('chat-activity-badge', compact && 'chat-activity-badge-compact', className)}
      data-state={activity.state}
      title={label}
    >
      <Icon className="chat-activity-icon" aria-hidden="true" />
      <span className={compact ? 'sr-only' : ''}>{label}</span>
    </span>
  );
}

export default memo(ActivityStatusBadge);
