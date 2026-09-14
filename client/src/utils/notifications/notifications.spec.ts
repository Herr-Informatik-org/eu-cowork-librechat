import type { TSubmission } from 'librechat-data-provider';
import type { CompletionResult } from './index';
import { notifyCompletion, notificationsEnabled, setNotificationsEnabled } from './index';

const submission = { initialResponse: { messageId: 'run-1' } } as TSubmission;
const result: CompletionResult = { final: true, conversation: { conversationId: 'chat-1' } };
const openConversation = jest.fn();
const close = jest.fn();
let notice: Notification;
const createNotification = jest.fn().mockImplementation(() => {
  notice = { close } as Partial<Notification> as Notification;
  return notice;
});
const deliver = (overrides: Partial<CompletionResult> = {}) =>
  notifyCompletion({
    userId: 'user-1',
    result: { ...result, ...overrides },
    submission,
    title: 'Antwort fertig',
    body: 'Deine Antwort ist bereit.',
    openConversation,
  });

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'Notification', { configurable: true, value: createNotification });
  Object.defineProperty(createNotification, 'permission', { configurable: true, value: 'granted' });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  jest.spyOn(document, 'hasFocus').mockReturnValue(false);
  setNotificationsEnabled('user-1', true);
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

it('notifies once for a successful background completion and opens its conversation', async () => {
  await deliver();
  await deliver();
  expect(createNotification).toHaveBeenCalledTimes(1);
  expect(createNotification).toHaveBeenCalledWith(
    'Antwort fertig',
    expect.objectContaining({
      body: 'Deine Antwort ist bereit.',
      tag: 'chat-1:run-1',
    }),
  );
  jest.spyOn(window, 'focus').mockImplementation(() => undefined);
  notice.onclick?.call(notice, new Event('click'));
  expect(openConversation).toHaveBeenCalledWith('chat-1');
  expect(close).toHaveBeenCalled();
});

it('suppresses a visible focused chat and its later background replay', async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible' });
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  await deliver();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  await deliver();
  expect(createNotification).not.toHaveBeenCalled();
});

it('notifies when another app has focus even if the tab is still visible', async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible' });
  await deliver();
  expect(createNotification).toHaveBeenCalledTimes(1);
});

it.each([
  { final: false },
  { aborted: true },
  { earlyAbort: true },
  { responseMessage: { unfinished: true } },
  { responseMessage: { error: true } },
  { runMessages: [{ error: true }] },
  { conversation: { conversationId: 'new' } },
])('does not notify for an unsuccessful result: %j', async (fields) => {
  await deliver(fields as Partial<CompletionResult>);
  expect(createNotification).not.toHaveBeenCalled();
});

it.each(['denied', 'default'])('respects %s permission', async (permission) => {
  Object.defineProperty(createNotification, 'permission', { value: permission });
  await deliver();
  expect(createNotification).not.toHaveBeenCalled();
});

it('keeps preferences per account and respects disabling them', async () => {
  expect(notificationsEnabled('user-2')).toBe(false);
  setNotificationsEnabled('user-1', false);
  await deliver();
  expect(createNotification).not.toHaveBeenCalled();
});

it('survives browsers without notification support or accessible storage', async () => {
  Object.defineProperty(window, 'Notification', { value: undefined });
  await expect(deliver()).resolves.toBeUndefined();
  Object.defineProperty(window, 'Notification', { value: createNotification });
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  await expect(deliver()).resolves.toBeUndefined();
  expect(createNotification).not.toHaveBeenCalled();
});

it('closes the notification when the user returns to the chat', async () => {
  await deliver();
  Object.defineProperty(document, 'visibilityState', { value: 'visible' });
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.dispatchEvent(new Event('focus'));
  expect(close).toHaveBeenCalled();
});
