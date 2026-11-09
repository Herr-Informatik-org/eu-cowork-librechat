import { Check, CircleAlert, LoaderCircle, Pause, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActivityState } from '~/store/activity';

export const activityIcons: Record<ActivityState, LucideIcon> = {
  waiting: LoaderCircle,
  running: LoaderCircle,
  'needs-input': TriangleAlert,
  done: Check,
  error: CircleAlert,
  stopped: Pause,
};
