import { memo, useId, useState } from 'react';
import { useRecoilValue } from 'recoil';
import {
  Circle,
  ListChecks,
  CircleCheck,
  CirclePause,
  ChevronDown,
  LoaderCircle,
} from 'lucide-react';
import type { TPlanStep } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import type { PlanSnapshot, StepDisplay } from './model';
import { useLatestMessageSelect } from '~/hooks/Messages/useLatestMessage';
import { selectTailPlan, stepDisplay, currentStep, planProgress } from './model';
import { useLocalize } from '~/hooks';
import store from '~/store';
import './plan.css';

const STATUS_KEYS: Record<StepDisplay, TranslationKeys> = {
  open: 'com_ui_plan_status_open',
  running: 'com_ui_plan_status_running',
  paused: 'com_ui_plan_status_paused',
  done: 'com_ui_plan_status_done',
};

function StepIcon({ display }: { display: StepDisplay }) {
  if (display === 'done') {
    return <CircleCheck className="kisuno-plan-icon" aria-hidden="true" />;
  }
  if (display === 'running') {
    return <LoaderCircle className="kisuno-plan-icon kisuno-plan-spin" aria-hidden="true" />;
  }
  if (display === 'paused') {
    return <CirclePause className="kisuno-plan-icon" aria-hidden="true" />;
  }
  return <Circle className="kisuno-plan-icon" aria-hidden="true" />;
}

function PlanStepRow({ step, live, folded }: { step: TPlanStep; live: boolean; folded: boolean }) {
  const localize = useLocalize();
  const display = stepDisplay(step, live);
  return (
    <li className="kisuno-plan-step" data-state={display} data-folded={folded || undefined}>
      <div className="kisuno-plan-step-inner" aria-hidden={folded || undefined}>
        <StepIcon display={display} />
        <span className="kisuno-plan-step-text">
          <span className={display === 'running' ? 'kisuno-shimmer' : undefined}>{step.text}</span>
          <span className="sr-only">{`, ${localize(STATUS_KEYS[display])}`}</span>
        </span>
      </div>
    </li>
  );
}

interface PanelState {
  messageId: string;
  total: number;
  manual: boolean | null;
  showDone: boolean;
}

export function PlanPanel({ snapshot, live }: { snapshot: PlanSnapshot; live: boolean }) {
  const localize = useLocalize();
  const bodyId = useId();
  const { plan, messageId } = snapshot;
  const progress = planProgress(plan);
  const [ui, setUi] = useState<PanelState>({
    messageId,
    total: progress.total,
    manual: null,
    showDone: false,
  });

  /** A new or extended plan opens again and forgets the person's last choice. */
  const fresh = ui.messageId !== messageId || progress.total > ui.total;
  const manual = fresh ? null : ui.manual;
  const showDone = fresh ? false : ui.showDone;
  const expanded = manual ?? !progress.complete;
  const update = (patch: Partial<Pick<PanelState, 'manual' | 'showDone'>>) =>
    setUi({ messageId, total: progress.total, manual, showDone, ...patch });

  const current = currentStep(plan);
  const progressText = localize('com_ui_plan_progress', {
    done: String(progress.done),
    total: String(progress.total),
  });
  const title = plan.title ?? localize('com_ui_plan');

  return (
    <section className="kisuno-plan" aria-label={localize('com_ui_plan')}>
      <button
        type="button"
        className="kisuno-plan-head"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => update({ manual: !expanded })}
      >
        <ListChecks className="kisuno-plan-icon" aria-hidden="true" />
        <span className="kisuno-plan-title">{title}</span>
        <span className="kisuno-plan-count" aria-label={progressText}>
          {`${progress.done}/${progress.total}`}
        </span>
        <span className="kisuno-plan-meter" aria-hidden="true">
          <span
            style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }}
          />
        </span>
        {!expanded && current && (
          <span className="kisuno-plan-current">
            <span aria-hidden="true">· </span>
            <span className={live && current.status === 'laeuft' ? 'kisuno-shimmer' : undefined}>
              {current.text}
            </span>
          </span>
        )}
        <ChevronDown className="kisuno-plan-chevron" aria-hidden="true" />
      </button>
      <div
        id={bodyId}
        className="kisuno-plan-body"
        data-open={expanded || undefined}
        aria-hidden={!expanded || undefined}
      >
        <div className="kisuno-plan-body-inner">
          <ol className="kisuno-plan-steps">
            {plan.steps.map((step, index) => (
              <PlanStepRow
                key={`${index}-${step.text}`}
                step={step}
                live={live}
                folded={step.status === 'erledigt' && !showDone}
              />
            ))}
          </ol>
          {progress.done > 0 && !progress.complete && (
            <button
              type="button"
              className="kisuno-plan-toggle"
              tabIndex={expanded ? 0 : -1}
              onClick={() => update({ showDone: !showDone })}
            >
              {showDone
                ? localize('com_ui_plan_hide_done')
                : localize('com_ui_plan_show_done', { n: String(progress.done) })}
            </button>
          )}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {`${localize('com_ui_plan')}: ${progressText}`}
      </span>
    </section>
  );
}

/**
 * The visible plan of the current request, docked above the composer. Reads
 * the newest `plan_aktualisieren` call of the branch tail, so it streams with
 * the run, survives a reload, and closes once the person sends a new message.
 */
function PlanBar({ index }: { index: number }) {
  const snapshot = useLatestMessageSelect(index, selectTailPlan);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  if (!snapshot) {
    return null;
  }
  return <PlanPanel key={conversationId ?? 'new'} snapshot={snapshot} live={isSubmitting} />;
}

export default memo(PlanBar);
