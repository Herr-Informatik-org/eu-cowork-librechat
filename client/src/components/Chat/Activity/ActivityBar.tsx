import { ArrowDown } from 'lucide-react';
import type { ConversationActivity } from '~/store/activity';
import type { TranslationKeys } from '~/hooks';
import { getToolDisplayLabel } from '~/utils/toolLabels';
import { useActivityTracking } from './useActivity';
import useSecondTick from '~/hooks/useSecondTick';
import { getStepLabel } from '~/utils/toolSteps';
import { formatElapsed } from '~/utils/elapsed';
import { useMCPServerNames } from '~/hooks/MCP';
import { activityLabel } from './model';
import { activityIcons } from './icons';
import { useLocalize } from '~/hooks';
import useHeld from './useHeld';
import './activity.css';

const LABEL_HOLD_MS = 650;
const SHOW_ELAPSED_AFTER_MS = 2_000;
const LONG_THINKING_MS = 15_000;
const LONGER_THINKING_MS = 45_000;
const FINISHED_VISIBLE_MS = 5_000;
const FINISHED_FADE_MS = 4_000;
const FADING_STATES = new Set<ConversationActivity['state']>(['done', 'stopped']);

const isActive = (activity: ConversationActivity) =>
  activity.state === 'waiting' || activity.state === 'running';

/** The stage label grows more patient over time instead of inventing progress. */
export function liveActivityLabel(
  activity: ConversationActivity,
  elapsedMs: number,
): TranslationKeys {
  const key = activityLabel(activity);
  if (!isActive(activity) || (activity.stage !== 'thinking' && activity.stage !== 'waiting')) {
    return key;
  }
  if (elapsedMs >= LONGER_THINKING_MS) {
    return 'com_ui_activity_thinking_longer';
  }
  if (elapsedMs >= LONG_THINKING_MS) {
    return 'com_ui_activity_thinking_long';
  }
  return key;
}

export default function ActivityBar() {
  const { activity } = useActivityTracking();
  if (!activity) return null;
  return <ActivityRow activity={activity} />;
}

function ActivityRow({ activity }: { activity: ConversationActivity }) {
  const localize = useLocalize();
  const serverNames = useMCPServerNames();
  const active = isActive(activity);
  const fading = FADING_STATES.has(activity.state);
  const now = Date.now();
  const sinceUpdate = now - activity.updatedAt;
  const recentlyFinished = fading && sinceUpdate < FINISHED_VISIBLE_MS;
  useSecondTick(active || recentlyFinished);

  const elapsedMs = Math.max(0, (active ? now : activity.updatedAt) - activity.startedAt);
  const labelKey = useHeld(liveActivityLabel(activity, elapsedMs), LABEL_HOLD_MS, !active);

  if (fading && !recentlyFinished) {
    return null;
  }

  const Icon = activityIcons[activity.state];
  const label = localize(labelKey);
  const tool =
    active && activity.stage === 'tool' && activity.tool
      ? (getStepLabel(activity.tool, 'running', localize) ??
        getToolDisplayLabel(activity.tool, localize, serverNames))
      : undefined;
  const showElapsed = elapsedMs >= SHOW_ELAPSED_AFTER_MS && activity.state !== 'needs-input';

  return (
    <div
      className="chat-activity-bar mx-auto w-full max-w-3xl px-4 py-2"
      data-state={activity.state}
      data-fading={fading && sinceUpdate >= FINISHED_FADE_MS ? 'true' : undefined}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2.5" aria-hidden="true">
        {active ? (
          <span className="chat-activity-orbit">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <Icon className="size-4 shrink-0" />
        )}
        <span key={labelKey} className="chat-activity-label min-w-0 text-xs font-medium">
          <span className={active ? 'kisuno-shimmer' : undefined}>{label}</span>
        </span>
        {tool && <span className="truncate text-xs text-text-secondary">· {tool}</span>}
        {showElapsed && (
          <span className="chat-activity-elapsed shrink-0 text-xs text-text-secondary">
            {formatElapsed(elapsedMs)}
          </span>
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
