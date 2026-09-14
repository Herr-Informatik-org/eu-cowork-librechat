const { FakeChatModel } = require('@librechat/agents');
const baseHook = require('./fake-model');
const {
  BRAIN_FACT,
  COMMAND_FACT,
  HISTORY_FACT,
  HISTORY_PROMPT,
  HISTORY_SUGGESTION,
} = require('./fake-brain-fixtures');
const SEARCH_CALL_ID = 'call_e2e_brain_search';

function messageType(message) {
  return message?.getType?.() ?? message?._getType?.() ?? message?.role ?? message?.type;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n');
}

function latestUserText(messages) {
  const latest = (messages ?? []).findLast((message) =>
    ['human', 'user'].includes(messageType(message)),
  );
  return contentText(latest?.content);
}

module.exports = function brainModelHook(run, context) {
  // Preserve every existing mock scenario. Select the Brain probe again at model
  // invocation, where resumed and formatted messages are actually available.
  baseHook(run, context);
  const graph = run?.Graph;
  const baseModel = graph?.overrideModel;
  if (!graph || !baseModel) throw new Error('E2E Brain probe: base model unavailable');
  const initialQuery = latestUserText(context?.messages);

  class BrainProbeModel extends FakeChatModel {
    searchStarted = false;
    commandStarted = false;

    async *_streamResponseChunks(messages, options, runManager) {
      const query = latestUserText(messages) || initialQuery;
      if (query === HISTORY_PROMPT) {
        this.responses = [HISTORY_SUGGESTION];
        yield* super._streamResponseChunks(messages, options, runManager);
        return;
      }
      if (!query.includes('E2E_BRAIN_PROBE') && !query.includes('E2E_BRAIN_COMMAND')) {
        yield* baseModel._streamResponseChunks(messages, options, runManager);
        return;
      }
      const agentId = runManager?.metadata?.agentId ?? options?.metadata?.agentId;
      const agent =
        graph.agentContexts.get(agentId) ??
        (graph.agentContexts.size === 1 ? [...graph.agentContexts.values()][0] : undefined);
      // Test model overrides bypass the SDK's production systemRunnable pipe.
      // Apply it here before inspecting the complete provider-facing prompt.
      const actual = agent?.systemRunnable ? await agent.systemRunnable.invoke(messages) : messages;
      const prompt = actual.map((message) => contentText(message.content)).join('\n');
      if (query.includes('E2E_BRAIN_COMMAND')) {
        let action = 'forget';
        if (query.includes('_REMEMBER')) action = 'remember';
        else if (query.includes('_UPDATE')) action = 'update';
        const callId = `call_brain_command_${action}`;
        if (!this.commandStarted) {
          const memory = prompt.split('\n').flatMap((line) => {
            try {
              const value = JSON.parse(line);
              return value.id && value.text?.includes('Projekt Orion') ? [value] : [];
            } catch {
              return [];
            }
          })[0];
          const argumentsByAction = {
            remember: {
              facts: [
                { quote: COMMAND_FACT, kind: 'project', scope: 'Projekt Orion', tags: ['Orion'] },
              ],
            },
            update: { id: memory?.id || 'missing', oldText: 'CHF', newText: 'EUR' },
            forget: { ids: [memory?.id || 'missing'] },
          };
          const args = argumentsByAction[action];
          this.commandStarted = true;
          yield this._createResponseChunk('', [
            {
              name: `brain_${action}`,
              args: JSON.stringify(args),
              id: callId,
              index: 0,
              type: 'tool_call_chunk',
            },
          ]);
          return;
        }
        const result = messages.find(
          (message) => messageType(message) === 'tool' && message.tool_call_id === callId,
        );
        let success = false;
        try {
          const parsed = JSON.parse(contentText(result?.content));
          if (action === 'remember')
            success = parsed.nodes?.some((node) => node.text === COMMAND_FACT);
          else if (action === 'update')
            success = parsed.updated && parsed.node.text === COMMAND_FACT.replace('CHF', 'EUR');
          else success = parsed.deleted === true;
        } catch {
          /* An actual error result must never be reported as success. */
        }
        this.responses = [success ? `E2E Brain ${action} verified` : `E2E Brain ${action} WRONG`];
        yield* super._streamResponseChunks(messages, options, runManager);
        return;
      }
      const present = prompt.includes(BRAIN_FACT);
      const expected = !query.includes('E2E_BRAIN_PROBE_ABSENT');
      let verified = present === expected;

      if (verified && expected) {
        if (!this.searchStarted) {
          const available = [...(agent?.tools ?? []), ...(agent?.graphTools ?? [])].some(
            (tool) => tool?.name === 'brain_search',
          );
          if (available) {
            this.searchStarted = true;
            // This is a real model tool-call chunk: the graph must execute its
            // registered brain_search and return a ToolMessage on the next turn.
            yield this._createResponseChunk('', [
              {
                name: 'brain_search',
                args: JSON.stringify({ query: 'Alpenblick Offerten CHF', seedIds: [] }),
                id: SEARCH_CALL_ID,
                index: 0,
                type: 'tool_call_chunk',
              },
            ]);
            return;
          }
          verified = false;
        } else {
          const result = messages.find(
            (message) => messageType(message) === 'tool' && message.tool_call_id === SEARCH_CALL_ID,
          );
          // Already loaded facts may be excluded from the second recall. Its
          // retrieval metadata still proves the service-backed tool completed.
          const text = contentText(result?.content);
          const metadata = text.slice(text.lastIndexOf('Brain retrieval: ') + 17);
          try {
            const parsed = JSON.parse(metadata);
            verified =
              Boolean(result) &&
              text.includes('Brain retrieval: ') &&
              typeof parsed.hasMore === 'boolean' &&
              typeof parsed.stopReason === 'string';
          } catch {
            verified = false;
          }
        }
      }
      this.responses = [verified ? 'E2E Brain context verified' : 'E2E Brain context WRONG'];
      yield* super._streamResponseChunks(messages, options, runManager);
    }
  }
  graph.overrideModel = new BrainProbeModel({
    responses: ['pending'],
    sleep: 1,
    emitCustomEvent: true,
  });
};
module.exports.BRAIN_FACT = BRAIN_FACT;
module.exports.COMMAND_FACT = COMMAND_FACT;
module.exports.HISTORY_FACT = HISTORY_FACT;
