import { ArrowDown } from 'lucide-react';
import { useActivityTracking } from './useActivity';
import { activityLabel } from './model';
import { activityIcons } from './icons';
import { useLocalize } from '~/hooks';
import './activity.css';

export default function ActivityBar() {
  const localize = useLocalize();
  const { activity } = useActivityTracking();
  if (!activity) return null;
  const active = activity.state === 'waiting' || activity.state === 'running';
  const Icon = activityIcons[activity.state];
  return (
    <div
      className="chat-activity-bar mx-auto w-full max-w-3xl px-4 py-2"
      data-state={activity.state}
    >
      <div
        className="flex min-w-0 items-center gap-2.5"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {active ? (
          <span className="chat-activity-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <Icon className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 text-xs font-medium">{localize(activityLabel(activity))}</span>
        {activity.tool && (
          <span className="truncate text-xs text-text-secondary">{activity.tool}</span>
        )}
      </div>
      {activity.state === 'needs-input' && (
        <button
          type="button"
          className="chat-activity-action"
          onClick={() => document.getElementById('prompt-textarea')?.focus()}
        >
          {localize('com_ui_activity_answer')}
          <ArrowDown className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
