// Isolate the SDK's duplicate hard-recursion rejection from the parent test process.
const { Run, Providers } = require('@librechat/agents');
const { AIMessageChunk, HumanMessage } = require('@librechat/agents/langchain/messages');
const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
(async () => {
  let calls = 0,
    effects = 0;
  const run = await Run.create({
    runId: 'isolated-unguarded',
    returnContent: true,
    preemption: { shouldPreempt: () => false },
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId: 'isolated',
          provider: Providers.OPENAI,
          clientOptions: {
            apiKey: 'synthetic-no-network',
            model: 'gpt-4o-mini',
            disableStreaming: true,
            configuration: {
              fetch: async () => {
                throw Error('External model transport forbidden');
              },
            },
          },
          graphTools: [
            new DynamicStructuredTool({
              name: 'read_fixture',
              description: 'Read synthetic data.',
              schema: z.object({}),
              func: async () => {
                effects++;
                return 'Synthetisches Ergebnis';
              },
            }),
          ],
        },
      ],
    },
  });
  run.Graph.overrideModel = {
    invoke: async () => {
      calls++;
      return new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: `call-${calls}`, name: 'read_fixture', args: '{}', index: 0 }],
      });
    },
  };
  try {
    await run.processStream(
      { messages: [new HumanMessage('Synthetischer endloser Testlauf.')] },
      { recursionLimit: 100, version: 'v2', streamMode: 'values' },
    );
  } catch (error) {
    console.log(JSON.stringify({ calls, effects, name: error.name, message: error.message }));
  }
})();
