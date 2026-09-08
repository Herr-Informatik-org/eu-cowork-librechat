import type { TMessage, TSubmission } from 'librechat-data-provider';
import {
  beginConversationActivity,
  clearConversationActivities,
  finishConversationActivity,
  getConversationActivity,
  updateConversationActivity,
  failConversationActivity,
  setConversationActivityUser,
} from './activity';

const message: TMessage = {
  messageId: 'response',
  conversationId: 'chat',
  parentMessageId: null,
  text: 'done',
  isCreatedByUser: false,
};
const submission = (clientRequestId = 'request', conversationId = 'chat') =>
  ({
    clientRequestId,
    conversation: { conversationId },
    userMessage: { ...message, messageId: 'user', isCreatedByUser: true },
    initialResponse: message,
  }) as TSubmission;

beforeEach(() => {
  sessionStorage.clear();
  setConversationActivityUser('test-user');
  clearConversationActivities();
});

test('a historic conversation is never guessed complete', () => {
  expect(getConversationActivity('historic')).toBeNull();
  updateConversationActivity('historic', { state: 'running', stage: 'writing' });
  expect(getConversationActivity('historic')).toBeNull();
});

test('submit responds immediately, real final completes, and rendering cannot reopen it', () => {
  beginConversationActivity(submission());
  expect(getConversationActivity('chat')?.state).toBe('waiting');
  updateConversationActivity('chat', { state: 'running', stage: 'tool', tool: 'web_search' });
  expect(getConversationActivity('chat')?.tool).toBe('web_search');
  finishConversationActivity(submission(), { final: true, responseMessage: message });
  expect(getConversationActivity('chat')?.state).toBe('done');
  beginConversationActivity(submission());
  updateConversationActivity('chat', { state: 'running', stage: 'writing' });
  expect(getConversationActivity('chat')?.state).toBe('done');
});

test('a stale final does not overwrite the next request in the same conversation', () => {
  beginConversationActivity(submission('first'));
  beginConversationActivity(submission('second'));
  finishConversationActivity(submission('first'), { final: true, responseMessage: message });
  expect(getConversationActivity('chat')?.runId).toBe('second');
  expect(getConversationActivity('chat')?.state).toBe('waiting');
});

test.each(['writing', 'thinking'] as const)('leaving a tool clears its name during %s', (stage) => {
  beginConversationActivity(submission());
  updateConversationActivity('chat', { state: 'running', stage: 'tool', tool: 'file_search' });
  updateConversationActivity('chat', { state: 'running', stage });
  expect(getConversationActivity('chat')).toMatchObject({ state: 'running', stage });
  expect(getConversationActivity('chat')?.tool).toBeUndefined();
});

test('new-chat identity migrates while keeping the observed request', () => {
  beginConversationActivity(submission('first', 'new'));
  beginConversationActivity(submission('first', 'new'), 'saved');
  expect(getConversationActivity('new')).toBeNull();
  expect(getConversationActivity('saved')?.runId).toBe('first');
});

test('the created server response replaces the optimistic response identity', () => {
  beginConversationActivity(submission());
  beginConversationActivity(submission(), 'chat', false, 'server-user-message_');
  expect(getConversationActivity('chat')?.messageId).toBe('server-user-message_');
});

test('a queued projection cannot restore the response identity from before an SSE sync', () => {
  beginConversationActivity(submission());
  const previous = getConversationActivity('chat')!;
  beginConversationActivity(submission(), 'chat', false, 'server-response');

  updateConversationActivity(
    'chat',
    { state: 'waiting', stage: 'waiting', messageId: previous.messageId },
    { runId: previous.runId, messageId: previous.messageId },
  );

  expect(getConversationActivity('chat')?.messageId).toBe('server-response');
});

test('a previous run projection cannot mark a reused response as writing', () => {
  beginConversationActivity(submission('first'));
  const previous = getConversationActivity('chat')!;
  beginConversationActivity(submission('second'));

  updateConversationActivity(
    'chat',
    { state: 'running', stage: 'writing', messageId: previous.messageId },
    { runId: previous.runId, messageId: previous.messageId },
  );

  expect(getConversationActivity('chat')).toMatchObject({ runId: 'second', state: 'waiting' });
});

test('a resumed request takes ownership of a reconstructed live question', () => {
  updateConversationActivity('chat', { state: 'needs-input', stage: 'question', messageId: 'ask' });
  beginConversationActivity(submission(), 'chat', false);
  finishConversationActivity(submission(), { final: true, responseMessage: message });
  expect(getConversationActivity('chat')?.state).toBe('done');
});

test('reload restores only observed outcomes for the same account, without message content', () => {
  beginConversationActivity(submission('finished'));
  finishConversationActivity(submission('finished'), { final: true, responseMessage: message });
  beginConversationActivity(submission('working', 'active-chat'));
  updateConversationActivity('paused-chat', {
    state: 'needs-input',
    stage: 'question',
    messageId: 'ask',
  });
  const saved = sessionStorage.getItem('eucowork:activity:v1:test-user') ?? '';
  expect(saved).not.toContain('messageId');
  expect(saved).not.toContain('active-chat');
  expect(saved).not.toContain('paused-chat');
  setConversationActivityUser(null);
  expect(getConversationActivity('chat')).toBeNull();
  setConversationActivityUser('other-user');
  expect(getConversationActivity('chat')).toBeNull();
  setConversationActivityUser('test-user');
  expect(getConversationActivity('chat')?.state).toBe('done');
  expect(getConversationActivity('active-chat')).toBeNull();
  expect(getConversationActivity('paused-chat')).toBeNull();
});

test('logout ignores late stream events from the previous account', () => {
  beginConversationActivity(submission());
  setConversationActivityUser(null);
  finishConversationActivity(submission(), { final: true, responseMessage: message });
  expect(getConversationActivity('chat')).toBeNull();
});

test('malformed storage and stored live states do not become completion evidence', () => {
  sessionStorage.setItem('eucowork:activity:v1:broken', '{broken');
  setConversationActivityUser('broken');
  expect(getConversationActivity('chat')).toBeNull();
  sessionStorage.setItem(
    'eucowork:activity:v1:live',
    JSON.stringify([
      { conversationId: 'chat', runId: 'run', state: 'running', startedAt: 1, updatedAt: 2 },
    ]),
  );
  setConversationActivityUser('live');
  expect(getConversationActivity('chat')).toBeNull();
});

test.each([
  { aborted: true },
  { earlyAbort: true },
  { responseMessage: { ...message, unfinished: true } },
  {},
])('abort or synthesized final is never a successful completion: %o', (fields) => {
  beginConversationActivity(submission());
  finishConversationActivity(submission(), fields);
  expect(getConversationActivity('chat')?.state).toBe('stopped');
});

test('failures and live input requests retain distinct states', () => {
  updateConversationActivity('paused', {
    state: 'needs-input',
    stage: 'question',
    messageId: 'ask',
  });
  expect(getConversationActivity('paused')?.state).toBe('needs-input');
  beginConversationActivity(submission());
  failConversationActivity(submission());
  expect(getConversationActivity('chat')?.state).toBe('error');
});
