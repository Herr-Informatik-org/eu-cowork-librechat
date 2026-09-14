import type { TSubmission } from 'librechat-data-provider';
import type { TFinalResData } from '~/common';

export type CompletionResult = TFinalResData & { aborted?: boolean; earlyAbort?: boolean };
const prefix = 'eucowork:notifications:v1:';

export const notificationsSupported = () =>
  window.isSecureContext && typeof window.Notification === 'function';

export function notificationsEnabled(userId?: string) {
  try {
    return !!userId && localStorage.getItem(`${prefix}${userId}:enabled`) === 'true';
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(userId: string, enabled: boolean) {
  localStorage.setItem(`${prefix}${userId}:enabled`, String(enabled));
}

export async function notifyCompletion({
  userId,
  result,
  submission,
  title,
  body,
  openConversation,
}: {
  userId?: string;
  result: CompletionResult;
  submission: TSubmission;
  title: string;
  body: string;
  openConversation: (conversationId: string) => void;
}) {
  const conversationId = result.conversation.conversationId;
  if (
    !userId ||
    !conversationId ||
    conversationId === 'new' ||
    result.final !== true ||
    result.aborted ||
    result.earlyAbort ||
    result.responseMessage?.unfinished ||
    result.responseMessage?.error ||
    result.runMessages?.some((message) => message.error || message.unfinished) ||
    !notificationsSupported()
  ) {
    return;
  }
  const runId = submission.clientRequestId ?? submission.initialResponse?.messageId;
  if (!runId) return;
  const key = `${prefix}${userId}:completed`;
  const identity = `${conversationId}:${runId}`;

  const deliver = () => {
    try {
      const parsed: string[] = JSON.parse(localStorage.getItem(key) || '[]');
      const completed = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
      if (completed.includes(identity)) return;
      // Record foreground completions too, so a replay cannot notify later.
      localStorage.setItem(key, JSON.stringify([...completed.slice(-199), identity]));
      if (
        !notificationsEnabled(userId) ||
        Notification.permission !== 'granted' ||
        (document.visibilityState === 'visible' && document.hasFocus())
      ) {
        return;
      }
      const notification = new Notification(title, {
        body,
        tag: identity,
        icon: new URL('assets/favicon-32x32.png', document.baseURI).href,
      });
      const closeWhenActive = () => {
        if (document.visibilityState === 'visible' && document.hasFocus()) notification.close();
      };
      const cleanup = () => {
        window.removeEventListener('focus', closeWhenActive);
        document.removeEventListener('visibilitychange', closeWhenActive);
        window.clearTimeout(timeout);
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        notification.close();
      }, 60_000);
      notification.onclick = () => {
        cleanup();
        notification.close();
        window.focus();
        openConversation(conversationId);
      };
      notification.onclose = cleanup;
      window.addEventListener('focus', closeWhenActive);
      document.addEventListener('visibilitychange', closeWhenActive);
    } catch {
      // Browser policy or unavailable storage must never interrupt chat completion.
    }
  };

  try {
    // Serialize claims across tabs when the browser supports Web Locks.
    if (navigator.locks) await navigator.locks.request(key, deliver);
    else deliver();
  } catch {
    // A closing document can reject a pending lock request.
  }
}
