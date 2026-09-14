import {
  conversationBranch,
  conversationMessages,
  conversationText,
  compatibleBrainEvidence,
} from './conversation';
import type { BrainStoredMessage } from './conversation';

const row = (messageId: string, user: boolean, parentMessageId?: string): BrainStoredMessage => ({
  messageId,
  conversationId: 'own',
  isCreatedByUser: user,
  parentMessageId,
  text: `Text ${messageId}`,
  createdAt: new Date(Number(messageId.replace(/\D/g, '')) * 1000),
});

describe('conversation reconstruction for personal knowledge', () => {
  it('keeps the continued branch without treating alternate assistant responses as corroboration', () => {
    const messages = conversationMessages([
      row('u1', true),
      row('a2', false, 'u1'),
      row('a3', false, 'u1'),
      row('u4', true, 'a2'),
    ]);
    expect(conversationBranch(messages, 'u4').map((message) => message.id)).toEqual([
      'u1',
      'a2',
      'u4',
    ]);
    expect(compatibleBrainEvidence(['a3', 'u4'], messages)).toBe(false);
    expect(compatibleBrainEvidence(['u1', 'a2', 'u4'], messages)).toBe(true);
  });

  it('reads visible structured text while excluding attachments, tools, unfinished and foreign context', () => {
    expect(
      conversationText({
        text: 'fallback',
        content: [
          null,
          { type: 'tool_call', text: 'secret output' },
          { type: 'text', text: 'First' },
          { type: 'text', text: { value: 'Second' } },
        ],
      }),
    ).toBe('First\nSecond');
    expect(
      conversationMessages([
        row('u1', true),
        { ...row('a2', false), unfinished: true },
        { ...row('u3', true), addedConvo: true },
        { ...row('u4', true), isTemporary: true },
      ]).map((message) => message.id),
    ).toEqual(['u1']);
  });
});
