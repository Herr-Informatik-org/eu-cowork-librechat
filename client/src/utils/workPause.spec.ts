import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { isWorkPauseText, isWorkPauseMessage } from './workPause';

const pause = JSON.stringify({
  type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
  status: 'incomplete',
  reason: 'section_limit',
});
const message: TMessage = {
  messageId: 'response',
  conversationId: 'chat',
  parentMessageId: null,
  isCreatedByUser: false,
  text: '',
  content: [{ type: ContentTypes.ERROR, error: pause }],
};

it('recognizes only controlled incomplete work pauses', () => {
  expect(isWorkPauseText(pause)).toBe(true);
  expect(
    isWorkPauseText(
      JSON.stringify({ type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED, status: 'incomplete' }),
    ),
  ).toBe(true);
  for (const reason of [
    'cost_limit',
    'time_limit',
    'uncertain_write',
    'review_required',
    'history_mismatch',
    'progress_unavailable',
  ]) {
    expect(
      isWorkPauseText(
        JSON.stringify({
          type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
          status: 'incomplete',
          reason,
        }),
      ),
    ).toBe(true);
  }
  for (const text of [
    'Connection failed',
    'null',
    '{}',
    JSON.stringify({ type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED }),
    JSON.stringify({
      type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
      status: 'incomplete',
      reason: 'control_unavailable',
    }),
    JSON.stringify({ type: 'network_error', status: 'incomplete' }),
  ]) {
    expect(isWorkPauseText(text)).toBe(false);
  }
});

it('restores a saved pause without mistaking user text or an earlier pause for the current state', () => {
  expect(isWorkPauseMessage(message)).toBe(true);
  expect(isWorkPauseMessage({ ...message, isCreatedByUser: true })).toBe(false);
  expect(isWorkPauseMessage({ ...message, content: undefined, text: pause, error: true })).toBe(
    true,
  );
  expect(
    isWorkPauseMessage({ ...message, content: [{ type: ContentTypes.TEXT, text: pause }] }),
  ).toBe(false);
  expect(
    isWorkPauseMessage({
      ...message,
      content: [
        ...message.content!,
        { type: ContentTypes.TEXT, text: 'Continued after the decision.' },
      ],
    }),
  ).toBe(false);
});
