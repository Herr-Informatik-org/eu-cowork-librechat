import { Check, Circle, CircleAlert, Pause, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActivityState } from '~/store/activity';

export const activityIcons: Record<ActivityState, LucideIcon> = {
  waiting: Circle,
  running: Circle,
  'needs-input': TriangleAlert,
  done: Check,
  error: CircleAlert,
  stopped: Pause,
};
