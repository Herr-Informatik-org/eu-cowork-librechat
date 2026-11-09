import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { applyPendingAction } from '~/utils/approval';
import { activityFromMessages, outcomeFromMessages } from './model';

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

test('a proposal waiting for a decision asks for input instead of showing a running tool', () => {
  const content: NonNullable<TMessage['content']> = [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'call-1',
        name: 'update_record_mcp_odoo',
        args: '{}',
        type: ToolCallTypes.TOOL_CALL,
        approval: { actionId: 'a1', allowed_decisions: ['approve', 'reject'] },
      },
    },
  ];
  expect(activityFromMessages([{ ...response, content }])).toMatchObject({
    state: 'needs-input',
    stage: 'question',
  });
});

describe('outcomeFromMessages for a run that ended in the background', () => {
  const user: TMessage = { ...response, messageId: 'user', isCreatedByUser: true, text: 'Hi' };

  test('a saved answer is a completed run', () => {
    expect(outcomeFromMessages([user, { ...response, text: 'Answer' }])).toEqual({
      state: 'done',
      stage: 'waiting',
      messageId: 'current',
    });
  });

  test('a saved error and an unfinished answer keep distinct outcomes', () => {
    expect(outcomeFromMessages([user, { ...response, error: true }])?.state).toBe('error');
    expect(outcomeFromMessages([user, { ...response, unfinished: true }])?.state).toBe('stopped');
  });

  test('a run without a saved response did not finish', () => {
    expect(outcomeFromMessages([user])).toMatchObject({ state: 'stopped', messageId: 'user' });
  });

  test('an open question waits for the user instead of claiming completion', () => {
    const pending = applyPendingAction(
      { ...response, text: 'Before I continue' },
      {
        actionId: 'ask-two',
        streamId: 'stream-two',
        createdAt: 0,
        payload: { type: 'ask_user_question', question: { question: 'Which year?' } },
      },
    );
    expect(outcomeFromMessages([user, pending])).toMatchObject({
      state: 'needs-input',
      stage: 'question',
    });
  });

  test('no saved messages give no outcome', () => {
    expect(outcomeFromMessages([])).toBeNull();
  });
});
