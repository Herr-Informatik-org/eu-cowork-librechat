import type { BrainSessionOptions } from './session';
import { conversationText } from './conversation';

interface PersistedSource {
  text?: string;
  content?: unknown[];
  isCreatedByUser?: boolean;
  isTemporary?: boolean;
  addedConvo?: boolean;
}

/** Require the original owned message to exist before any durable learning. */
export async function isBrainSourcePersisted(
  options: Pick<BrainSessionOptions, 'userId' | 'conversationId' | 'source'>,
  getMessages: (filter: {
    user: string;
    conversationId: string;
    messageId: string;
  }) => Promise<PersistedSource[]>,
): Promise<boolean> {
  const messages = await getMessages({
    user: options.userId,
    conversationId: options.conversationId,
    messageId: options.source.id,
  });
  return messages.some(
    (message) =>
      message.isCreatedByUser === true &&
      message.isTemporary !== true &&
      message.addedConvo !== true &&
      conversationText(message) === options.source.text,
  );
}
