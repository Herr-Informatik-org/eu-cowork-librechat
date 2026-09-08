const { DynamicStructuredTool } = require('@langchain/core/tools');
const { convertToOpenAITool } = require('@langchain/core/utils/function_calling');
const { createSearchTool } = require('@librechat/agents');
const { getToolDefinition } = require('@librechat/api');
const { prepareWebSearchTool } = require('./prepareWebSearchTool');

function createTool(func, responseFormat) {
  return new DynamicStructuredTool({
    name: 'web_search',
    description: 'Search for official documentation.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        date: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'] },
      },
      required: ['query'],
    },
    func,
    responseFormat,
  });
}

describe('prepareWebSearchTool', () => {
  it('uses the same schema as the event-driven model definition registry', () => {
    const tool = prepareWebSearchTool(
      createSearchTool({
        serperApiKey: 'test-serper-key',
        firecrawlApiKey: 'test-firecrawl-key',
        rerankerType: 'none',
      }),
    );
    const registrySchema = getToolDefinition('web_search').schema;
    expect(tool.schema).toEqual(registrySchema);
    expect(registrySchema.properties.date.anyOf).toContainEqual({ type: 'null' });
  });

  it('offers explicit all-time input in the model schema without mutating the original schema', () => {
    const tool = createTool(async () => 'source');
    const originalSchema = tool.schema;
    prepareWebSearchTool(tool);
    const converted = convertToOpenAITool(tool).function.parameters;
    expect(converted.required).toEqual(['query']);
    expect(converted.properties.date.anyOf).toEqual([
      originalSchema.properties.date,
      { type: 'null' },
    ]);
    expect(originalSchema.properties.date).toEqual({
      type: 'string',
      enum: ['h', 'd', 'w', 'm', 'y'],
    });
  });

  it.each([null, undefined, 'h', 'd', 'w', 'm', 'y'])(
    'preserves query and date=%s through the real LangChain invocation',
    async (date) => {
      const original = jest.fn(async (input) => JSON.stringify(input));
      const tool = prepareWebSearchTool(createTool(original));
      const input = { query: 'AWS Bedrock', ...(date === undefined ? {} : { date }) };
      expect(await tool.invoke(input)).toBe(JSON.stringify(input));
      expect(original).toHaveBeenCalledTimes(1);
      expect(original.mock.calls[0][0]).toEqual(input);
    },
  );

  it.each(['', ' \n ', null, undefined])(
    'explains an empty result (%s) without claiming search success or retrying automatically',
    async (result) => {
      const original = jest.fn(async () => result);
      const tool = prepareWebSearchTool(createTool(original));
      const output = await tool.invoke({ query: 'AWS Bedrock', date: null });
      expect(output).toContain('keine verwertbaren Ergebnisse');
      expect(output).toContain('date: null');
      expect(original).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves real source output and citation anchors exactly', async () => {
    const result = '=== Web Results ===\nURL: https://docs.aws.amazon.com/\nturn0search0';
    const tool = prepareWebSearchTool(createTool(async () => result));
    expect(await tool.invoke({ query: 'AWS Bedrock' })).toBe(result);
  });

  it('does not mask a thrown provider error', async () => {
    const failure = new Error('Search provider unavailable');
    const tool = prepareWebSearchTool(
      createTool(async () => {
        throw failure;
      }),
    );
    await expect(tool.invoke({ query: 'AWS Bedrock' })).rejects.toThrow(failure);
  });

  it.each(['', ' \n ', null, undefined])(
    'explains empty artifact content (%s) through the chat ToolMessage path',
    async (content) => {
      const artifact = { web_search: { organic: [], error: 'Search unavailable' } };
      const original = jest.fn(async () => [content, artifact]);
      const tool = prepareWebSearchTool(createTool(original, 'content_and_artifact'));
      const result = await tool.invoke({
        type: 'tool_call',
        id: 'search-call-1',
        name: 'web_search',
        args: { query: 'AWS Bedrock', date: null },
      });
      expect(result.content).toContain('keine verwertbaren Ergebnisse');
      expect(result.artifact).toBe(artifact);
      expect(result.tool_call_id).toBe('search-call-1');
      expect(original).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves a real search tuple with sources and citations exactly', async () => {
    const result = [
      'Official source: https://docs.aws.amazon.com/ turn0search0',
      { web_search: { organic: [{ link: 'https://docs.aws.amazon.com/' }] } },
    ];
    const tool = prepareWebSearchTool(createTool(async () => result, 'content_and_artifact'));
    expect(await tool.func({ query: 'AWS Bedrock', date: null })).toBe(result);
  });
});
