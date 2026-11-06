/**
 * The `<naechste_schritte>` block must be cut out before aggregation and emission:
 * it may never reach the stored content or the client stream, however it is chunked.
 */
const mockSendEvent = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  sendEvent: (...args) => mockSendEvent(...args),
}));
jest.mock('~/server/services/Files/Citations', () => ({ processFileCitations: jest.fn() }));
jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({ saveBase64Image: jest.fn() }));

const { GraphEvents, createContentAggregator } = require('@librechat/agents');
const { createNextStepsSink } = require('@librechat/api');
const { getDefaultHandlers } = require('../callbacks');

const metadata = { last_agent_id: 'agent', langgraph_node: 'agent=agent' };

function setup() {
  mockSendEvent.mockClear();
  const { contentParts, aggregateContent } = createContentAggregator();
  const nextStepsSink = createNextStepsSink();
  const handlers = getDefaultHandlers({
    res: { write: jest.fn() },
    aggregateContent,
    contentParts,
    toolEndCallback: jest.fn(),
    collectedUsage: [],
    nextStepsSink,
  });
  const runStep = (id, index, stepDetails) =>
    handlers[GraphEvents.ON_RUN_STEP].handle(
      GraphEvents.ON_RUN_STEP,
      { id, index, runId: 'run', type: stepDetails.type, stepDetails },
      metadata,
    );
  const text = (id, chunk) =>
    handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      { id, delta: { content: [{ type: 'text', text: chunk }] } },
      metadata,
    );
  const streamed = () =>
    mockSendEvent.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.event === GraphEvents.ON_MESSAGE_DELTA)
      .flatMap((event) => event.data.delta.content.map((part) => part.text))
      .join('');
  return { contentParts, nextStepsSink, runStep, text, streamed };
}

const messageStep = { type: 'message_creation', message_creation: { message_id: 'm1' } };

describe('next steps in the agent stream', () => {
  it('keeps the block out of content and the client stream, however it is split', async () => {
    const answer = 'Die Liste ist erstellt.';
    const full = `${answer}\n\n<naechste_schritte>\nSortiere die Liste nach Betrag\nSchreibe Herrn Frei: …\n</naechste_schritte>`;
    for (const size of [1, 3, 7, full.length]) {
      const { contentParts, nextStepsSink, runStep, text, streamed } = setup();
      await runStep('step_1', 0, messageStep);
      for (let i = 0; i < full.length; i += size) {
        await text('step_1', full.slice(i, i + size));
      }
      await nextStepsSink.flush();
      expect(contentParts[0].text).toBe(answer);
      expect(streamed()).toBe(answer);
      expect(nextStepsSink.take()).toEqual([
        { text: 'Sortiere die Liste nach Betrag' },
        { text: 'Schreibe Herrn Frei:', needsInput: true },
      ]);
    }
  });

  it('releases a held tail to its own step when a tool step starts', async () => {
    const { contentParts, nextStepsSink, runStep, text, streamed } = setup();
    await runStep('step_1', 0, messageStep);
    await text('step_1', 'Ich prüfe a <');
    await runStep('step_2', 1, {
      type: 'tool_calls',
      tool_calls: [{ id: 'call_1', name: 'web_search', args: '{}' }],
    });
    expect(contentParts[0].text).toBe('Ich prüfe a <');
    expect(streamed()).toBe('Ich prüfe a <');
    expect(nextStepsSink.take()).toBeUndefined();
  });
});
