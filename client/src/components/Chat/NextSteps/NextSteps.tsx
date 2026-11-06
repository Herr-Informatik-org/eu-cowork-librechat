import { memo, useState, useCallback } from 'react';
import type { TMessage, TNextStep } from 'librechat-data-provider';
import { isAskUserQuestionPart, isAnsweredAskUserQuestionPart } from '~/utils/approval';
import { insertIntoComposer, nextStepLabel } from './insert';
import { useLocalize } from '~/hooks';
import './chips.css';

/** Highest stagger step; later chips appear together with the last staggered one. */
const MAX_STAGGER = 5;

/** A question the person still has to answer keeps the composer for the answer. */
function hasOpenQuestion(message: TMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) => isAskUserQuestionPart(part) && !isAnsweredAskUserQuestionPart(part),
  );
}

/** Whether the chips may show under this message right now. */
export function canShowNextSteps(message: TMessage | undefined, isSubmitting: boolean): boolean {
  if (!message || isSubmitting || message.isCreatedByUser) {
    return false;
  }
  if (message.unfinished === true || message.error === true) {
    return false;
  }
  if ((message.nextSteps?.length ?? 0) === 0) {
    return false;
  }
  return !hasOpenQuestion(message);
}

function NextStepChips({ steps }: { steps: TNextStep[] }) {
  const localize = useLocalize();
  const [status, setStatus] = useState('');
  const insert = useCallback(
    (step: TNextStep) => {
      if (insertIntoComposer(step)) {
        setStatus(localize('com_ui_next_step_inserted'));
      }
    },
    [localize],
  );

  return (
    <div className="kisuno-next-steps" role="group" aria-label={localize('com_ui_next_steps')}>
      {steps.map((step, index) => {
        const label = nextStepLabel(step);
        return (
          <button
            key={`${index}-${step.text}`}
            type="button"
            className="kisuno-next-step"
            style={{ '--kisuno-stagger': Math.min(index, MAX_STAGGER) } as React.CSSProperties}
            title={label}
            onClick={() => insert(step)}
          >
            <span className="kisuno-next-step-text">{label}</span>
            {step.needsInput === true && (
              <span className="sr-only">{`, ${localize('com_ui_next_step_needs_input')}`}</span>
            )}
          </button>
        );
      })}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

/**
 * «Continue with» chips under the latest complete answer. A click loads the
 * suggestion into the composer (never sends, never overwrites a draft); open
 * suggestions ending in «…» are left for the person to complete.
 */
function NextSteps({ message, isSubmitting }: { message?: TMessage; isSubmitting: boolean }) {
  if (!canShowNextSteps(message, isSubmitting) || !message?.nextSteps) {
    return null;
  }
  return <NextStepChips steps={message.nextSteps} />;
}

export default memo(NextSteps);
