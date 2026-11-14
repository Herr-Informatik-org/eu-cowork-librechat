import { applyWorkCostEvent, parseWorkCost } from './workCost';
import type { TMessage } from 'librechat-data-provider';
const summary = {
  requestUsd: 1.5,
  requestReservedUsd: 0.2,
  dayUsd: 20,
  requestLimitUsd: 10,
  dayLimitUsd: 50,
  warning: true,
  at: 100,
};
it('rejects malformed or nonfinite cost events', () => {
  for (const bad of [
    null,
    {},
    { ...summary, requestUsd: NaN },
    { ...summary, at: -1 },
    { ...summary, warning: 'yes' },
  ])
    expect(parseWorkCost(bad)).toBeUndefined();
  expect(parseWorkCost(summary)).toEqual(summary);
});
it('applies only to the matching assistant message and ignores duplicate or stale events', () => {
  const messages = [
    { messageId: 'u', isCreatedByUser: true },
    { messageId: 'a', isCreatedByUser: false, metadata: { retained: true } },
  ] as unknown as TMessage[];
  expect(applyWorkCostEvent(messages, { messageId: 'u', summary })).toBe(messages);
  expect(applyWorkCostEvent(messages, { messageId: 'other', summary })).toBe(messages);
  const next = applyWorkCostEvent(messages, { messageId: 'a', summary });
  expect(next[1].metadata).toEqual({ retained: true, workCost: summary });
  expect(messages[1].metadata).toEqual({ retained: true });
  expect(applyWorkCostEvent(next, { messageId: 'a', summary: { ...summary, at: 99 } })).toBe(next);
});
