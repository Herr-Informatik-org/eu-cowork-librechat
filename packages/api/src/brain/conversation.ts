import { createHash } from 'node:crypto';

export interface BrainTextPart {
  type?: string;
  text?: string | { value?: string };
}

export interface BrainStoredMessage {
  messageId: string;
  conversationId: string;
  parentMessageId?: string | null;
  text?: string;
  content?: unknown[];
  isCreatedByUser?: boolean;
  isTemporary?: boolean;
  addedConvo?: boolean;
  unfinished?: boolean;
  error?: boolean;
  expiredAt?: Date | null;
  createdAt: Date | string;
}

export interface BrainConversationMessage {
  id: string;
  text: string;
  role: 'user' | 'assistant';
  parentId?: string;
  createdAt: string;
  contentHash: string;
}

export function conversationText(message: Pick<BrainStoredMessage, 'text' | 'content'>): string {
  const parts = message.content?.flatMap((part) => {
    if (
      !part ||
      typeof part !== 'object' ||
      !('type' in part) ||
      part.type !== 'text' ||
      !('text' in part)
    )
      return [];
    let value: unknown = part.text;
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    return typeof value === 'string' ? [value] : [];
  });
  return parts?.length ? parts.join('\n') : (message.text ?? '');
}

export const conversationHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export function conversationMessages(records: BrainStoredMessage[]): BrainConversationMessage[] {
  return records
    .filter(
      (message) =>
        !message.isTemporary &&
        !message.addedConvo &&
        !message.unfinished &&
        !message.error &&
        !message.expiredAt &&
        typeof message.isCreatedByUser === 'boolean',
    )
    .map((message) => {
      const text = conversationText(message);
      return {
        id: message.messageId,
        text,
        role: message.isCreatedByUser ? ('user' as const) : ('assistant' as const),
        parentId: message.parentMessageId ?? undefined,
        createdAt: new Date(message.createdAt).toISOString(),
        contentHash: conversationHash(text),
      };
    })
    .filter((message) => message.text.trim())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function conversationTranscript(messages: BrainConversationMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

/** Evidence must belong to one parent chain; sibling alternatives cannot confirm each other. */
export function compatibleBrainEvidence(
  ids: string[],
  messages: BrainConversationMessage[],
): boolean {
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (ids.some((id) => !byId.has(id))) return false;
  if (!messages.some((message) => message.parentId)) return true;
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next && !seen.has(next)) {
      seen.add(next);
      next = byId.get(next)?.parentId;
    }
    return seen;
  };
  return ids.some((id) => {
    const chain = ancestors(id);
    return ids.every((sourceId) => chain.has(sourceId));
  });
}

/** Read the actual branch leading to the current user turn, excluding sibling responses. */
export function conversationBranch(
  messages: BrainConversationMessage[],
  messageId: string,
): BrainConversationMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const target = byId.get(messageId);
  if (!target) return [];
  if (!messages.some((message) => message.parentId)) {
    return messages.filter((message) => message.createdAt <= target.createdAt);
  }
  const chain = new Set<string>();
  let next: string | undefined = messageId;
  while (next && byId.has(next) && !chain.has(next)) {
    chain.add(next);
    next = byId.get(next)?.parentId;
  }
  return messages.filter((message) => chain.has(message.id));
}
