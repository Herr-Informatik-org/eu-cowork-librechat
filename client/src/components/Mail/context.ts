import type { MailWorkspaceChatRequest } from 'librechat-data-provider';

const requestLimit = 24000;
const serializedLength = (request: MailWorkspaceChatRequest) => JSON.stringify(request).length;

/** Bound transport context without changing the visible conversation or the user's draft. */
export function buildMailChatRequest(
  input: MailWorkspaceChatRequest,
): MailWorkspaceChatRequest | undefined {
  const request: MailWorkspaceChatRequest = {
    revision: input.revision,
    message: input.message.trim().slice(0, 4000),
    history: input.history.slice(-12).map(({ role, content }) => ({
      role,
      content: content.slice(0, 4000),
    })),
    ...(input.draft !== undefined ? { draft: input.draft.slice(0, 12000) } : {}),
    includeCorrespondence: input.includeCorrespondence,
  };
  if (!request.message) return;
  while (request.history.length && serializedLength(request) > requestLimit) {
    request.history.shift();
  }
  if (serializedLength(request) > requestLimit && request.draft) {
    const draft = request.draft;
    let start = 0;
    let end = draft.length;
    while (start < end) {
      const length = Math.ceil((start + end) / 2);
      request.draft = draft.slice(0, length);
      if (serializedLength(request) <= requestLimit) start = length;
      else end = length - 1;
    }
    request.draft = draft.slice(0, start);
  }
  return serializedLength(request) <= requestLimit ? request : undefined;
}
