import { memo } from 'react';
import { useConversationActivity } from './useActivity';
import { activityLabel } from './model';
import { activityIcons } from './icons';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import './activity.css';

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
  if (active === false && (observed?.state === 'waiting' || observed?.state === 'running'))
    return null;
  const activity =
    observed ??
    (active
      ? {
          conversationId,
          runId: '',
          state: 'running' as const,
          stage: 'thinking' as const,
          startedAt: 0,
          updatedAt: 0,
        }
      : null);
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
