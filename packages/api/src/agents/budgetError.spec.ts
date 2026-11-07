import { GraphRecursionError } from '@langchain/langgraph';
import mongoose from 'mongoose';
import { messageSchema } from '@librechat/data-schemas';
import { ErrorTypes, ContentTypes } from 'librechat-data-provider';
import { isAgentBudgetError, resolveAgentBudgetError } from './budgetError';

describe('agent budget termination', () => {
  it('recognizes the installed graph runtime error without relying on its message', () => {
    const error = new GraphRecursionError('Runtime-specific wording', {
      lc_error_code: 'GRAPH_RECURSION_LIMIT',
    });
    expect(isAgentBudgetError(error)).toBe(true);
  });

  it.each([
    { name: 'GraphRecursionError' },
    { lc_error_code: 'GRAPH_RECURSION_LIMIT' },
    { code: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED },
  ])('recognizes a structured termination signal: %j', (error) => {
    expect(resolveAgentBudgetError(error)).toBe(
      JSON.stringify({ type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED, status: 'incomplete' }),
    );
  });

  it.each([
    undefined,
    null,
    'GraphRecursionError: Recursion limit of 108 reached',
    new Error('GraphRecursionError: Recursion limit of 108 reached'),
    { message: 'Recursion limit of 108 reached' },
    { lc_error_code: 'INVALID_GRAPH_NODE_RETURN_VALUE' },
  ])('does not misclassify ordinary errors or tool text: %j', (error) => {
    expect(resolveAgentBudgetError(error)).toBeUndefined();
  });

  it('round-trips through the existing message schema without retry or unfinished flags', () => {
    const content = [
      { type: ContentTypes.TEXT, text: 'Vorhandenes Ergebnis' },
      {
        type: ContentTypes.ERROR,
        error: resolveAgentBudgetError({ name: 'GraphRecursionError' }),
      },
    ];
    const Message = mongoose.model('AgentBudgetErrorTest', messageSchema.clone());
    const message = new Message({
      messageId: 'response-1',
      conversationId: 'conversation-1',
      parentMessageId: 'user-1',
      sender: 'Assistant',
      text: '',
      isCreatedByUser: false,
      user: 'user-1',
      content,
    });
    expect(message.validateSync()).toBeUndefined();
    expect(message.toObject().content).toEqual(content);
    expect(message.unfinished).not.toBe(true);
    expect(message.error).not.toBe(true);
    mongoose.deleteModel('AgentBudgetErrorTest');
  });
});
