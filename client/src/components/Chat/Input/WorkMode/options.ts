import { ClipboardList, ShieldQuestion, Zap } from 'lucide-react';
import type { WorkMode } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export interface ModeOption {
  mode: WorkMode;
  label: TranslationKeys;
  description: TranslationKeys;
  Icon: typeof Zap;
}

export const WORK_MODE_OPTIONS: readonly ModeOption[] = [
  {
    mode: 'plan',
    label: 'com_ui_work_mode_plan',
    description: 'com_ui_work_mode_plan_description',
    Icon: ClipboardList,
  },
  {
    mode: 'ask',
    label: 'com_ui_work_mode_ask',
    description: 'com_ui_work_mode_ask_description',
    Icon: ShieldQuestion,
  },
  {
    mode: 'auto',
    label: 'com_ui_work_mode_auto',
    description: 'com_ui_work_mode_auto_description',
    Icon: Zap,
  },
];
