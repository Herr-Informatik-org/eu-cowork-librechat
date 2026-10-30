import { createContext, useContext } from 'react';
import type { TAttachment } from 'librechat-data-provider';

type MessageContext = {
  messageId: string;
  /** Only attachments of this assistant message may resolve generated sandbox links. */
  downloadAttachments?: readonly TAttachment[];
  nextType?: string;
  partIndex?: number;
  isExpanded: boolean;
  conversationId?: string | null;
  /** Submission state for cursor display - only true for latest message when submitting */
  isSubmitting?: boolean;
  /** Whether this is the latest message in the conversation */
  isLatestMessage?: boolean;
};

export const MessageContext = createContext<MessageContext>({} as MessageContext);
export const useMessageContext = () => useContext(MessageContext);
