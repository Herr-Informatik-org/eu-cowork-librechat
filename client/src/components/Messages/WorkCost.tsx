import { useLocalize } from '~/hooks';
import { parseWorkCost } from '~/utils/workCost';

export default function WorkCost({ value }: { value: unknown }) {
  const localize = useLocalize();
  const summary = parseWorkCost(value);
  if (!summary) return null;
  const warning = summary.warning || summary.dayUsd >= summary.dayLimitUsd;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-2 text-xs ${warning ? 'text-amber-700 dark:text-amber-300' : 'text-text-secondary'}`}
      data-testid="work-cost-status"
    >
      {warning && <span>{localize('com_ui_work_cost_warning')} </span>}
      {localize('com_ui_work_cost_status', {
        0: summary.requestUsd.toFixed(2),
        1: summary.requestLimitUsd.toFixed(2),
        2: summary.dayUsd.toFixed(2),
        3: summary.dayLimitUsd.toFixed(2),
      })}
      {(summary.requestReservedUsd > 0.005 || (summary.dayReservedUsd ?? 0) > 0.005) && (
        <div>
          {localize('com_ui_work_cost_reserved', {
            0: summary.requestReservedUsd.toFixed(2),
            1: (summary.dayReservedUsd ?? 0).toFixed(2),
          })}
        </div>
      )}
    </div>
  );
}
