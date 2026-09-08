import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { applyPendingAction } from '~/utils/approval';
import { activityFromMessages } from './model';

const response: TMessage = {
  messageId: 'current',
  conversationId: 'chat',
  parentMessageId: 'user',
  isCreatedByUser: false,
  text: '',
};

test('empty stream waits, reasoning thinks, text writes, and no phase invents completion', () => {
  expect(activityFromMessages([response])).toMatchObject({ state: 'waiting', stage: 'waiting' });
  expect(
    activityFromMessages([
      { ...response, content: [{ type: ContentTypes.THINK, think: 'Planning' }] },
    ]),
  ).toMatchObject({ state: 'running', stage: 'thinking' });
  expect(activityFromMessages([{ ...response, text: 'A complete-looking answer' }])).toMatchObject({
    state: 'running',
    stage: 'writing',
  });
});

test('tool input and output select real work phases including sparse stream parts', () => {
  const content: NonNullable<TMessage['content']> = [];
  content[2] = {
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      type: ToolCallTypes.TOOL_CALL,
      id: 'search',
      name: 'web_search',
      args: '{}',
      progress: 0,
    },
  };
  expect(activityFromMessages([{ ...response, content }])).toMatchObject({
    state: 'running',
    stage: 'tool',
    tool: 'web_search',
  });
  content[2].tool_call.progress = 1;
  expect(activityFromMessages([{ ...response, content }])).toMatchObject({
    state: 'running',
    stage: 'thinking',
  });
});

test('regenerate follows its actual response instead of a later branch sibling', () => {
  const current = {
    ...response,
    content: [{ type: ContentTypes.THINK as const, think: 'Working' }],
  };
  expect(
    activityFromMessages(
      [current, { ...response, messageId: 'old-sibling', text: 'Old answer' }],
      'current',
    ),
  ).toMatchObject({ stage: 'thinking', messageId: 'current' });
});

test('a new response waits for its first frame instead of reporting old text as live output', () => {
  expect(activityFromMessages([{ ...response, text: 'Earlier answer' }], 'next-response')).toEqual({
    state: 'waiting',
    stage: 'waiting',
    messageId: 'next-response',
  });
});

test('a real pending question takes priority over previous writing', () => {
  const pending = applyPendingAction(response, {
    actionId: 'ask-one',
    streamId: 'stream-one',
    createdAt: 0,
    payload: { type: 'ask_user_question', question: { question: 'Word or Excel?' } },
  });
  expect(activityFromMessages([pending])).toMatchObject({
    state: 'needs-input',
    stage: 'question',
  });
});
