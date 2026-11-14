import type { TMessage, TWorkCostSummary } from 'librechat-data-provider';

export function parseWorkCost(value: unknown): TWorkCostSummary | undefined {
  if (!value || typeof value !== 'object') return;
  const summary = value as TWorkCostSummary;
  if (
    ['requestUsd', 'requestReservedUsd', 'dayUsd', 'requestLimitUsd', 'dayLimitUsd', 'at'].some(
      (key) => {
        const number = summary[key as keyof TWorkCostSummary];
        return typeof number !== 'number' || !Number.isFinite(number) || number < 0;
      },
    ) ||
    typeof summary.warning !== 'boolean'
  )
    return;
  if (
    summary.dayReservedUsd != null &&
    (!Number.isFinite(summary.dayReservedUsd) || summary.dayReservedUsd < 0)
  )
    return;
  return summary;
}
export function applyWorkCostEvent(messages: TMessage[], event: unknown): TMessage[] {
  if (!event || typeof event !== 'object') return messages;
  const payload = event as { messageId?: string; summary?: unknown };
  const summary = parseWorkCost(payload.summary);
  if (!payload.messageId || !summary) return messages;
  const index = messages.findIndex(
    (message) => message.messageId === payload.messageId && !message.isCreatedByUser,
  );
  if (index < 0) return messages;
  const message = messages[index];
  const current = parseWorkCost(message.metadata?.workCost);
  if (current && current.at >= summary.at) return messages;
  const next = [...messages];
  next[index] = { ...message, metadata: { ...message.metadata, workCost: summary } };
  return next;
}
