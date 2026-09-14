import { isBrainSourcePersisted } from './source';

describe('persisted Brain provenance', () => {
  const options = {
    userId: 'owner',
    conversationId: 'conversation',
    source: { id: 'message', text: 'Ich arbeite an Atlas.', createdAt: '2026-09-14' },
  };
  it('queries only the original message owned by the current user', async () => {
    const getMessages = jest
      .fn()
      .mockResolvedValue([{ isCreatedByUser: true, text: options.source.text }]);
    expect(await isBrainSourcePersisted(options, getMessages)).toBe(true);
    expect(getMessages).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'message',
    });
  });
  it.each([
    { messages: [] },
    { messages: [{ isCreatedByUser: false, text: options.source.text }] },
    { messages: [{ isCreatedByUser: true, text: 'Inzwischen geändert.' }] },
    { messages: [{ isCreatedByUser: true, text: options.source.text, isTemporary: true }] },
    { messages: [{ isCreatedByUser: true, text: options.source.text, addedConvo: true }] },
  ])('rejects missing, assistant and changed source messages: %j', async ({ messages }) => {
    expect(await isBrainSourcePersisted(options, async () => messages)).toBe(false);
  });
});
