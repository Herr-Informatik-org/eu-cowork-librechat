import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import { PLAN_TOOL_NAME, findLatestPlan, parsePlanArgs } from 'librechat-data-provider';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { PlanReminderRun } from './reminder';
import { continueOpenPlan, buildPlanReminder } from './reminder';
import { createPlanTool, describePlanUpdate } from './tool';
import { buildChatGuidance } from '../guidance';

const planPart = (schritte: Array<{ schritt: string; status: string }>, titel?: string) => ({
  type: 'tool_call',
  tool_call: { name: PLAN_TOOL_NAME, args: JSON.stringify({ titel, schritte }) },
});

const OPEN_PLAN = [
  planPart([
    { schritt: 'Rechnungen lesen', status: 'erledigt' },
    { schritt: 'Mahnliste erstellen', status: 'laeuft' },
    { schritt: 'Entwurf schreiben', status: 'offen' },
  ]),
];

const DONE_PLAN = [
  planPart([
    { schritt: 'Rechnungen lesen', status: 'erledigt' },
    { schritt: 'Mahnliste erstellen', status: 'erledigt' },
  ]),
];

function fakeRun(options: {
  interrupt?: unknown;
  halt?: string;
  runMessages?: BaseMessage[];
  saved?: BaseMessage[] | Error;
}): PlanReminderRun & { calls: Array<{ messages: BaseMessage[]; keepContent?: boolean }> } {
  const calls: Array<{ messages: BaseMessage[]; keepContent?: boolean }> = [];
  return {
    calls,
    processStream: async (inputs, _config, streamOptions) => {
      calls.push({ messages: inputs.messages, keepContent: streamOptions?.keepContent });
      return undefined;
    },
    getInterrupt: () => options.interrupt,
    getHaltReason: () => options.halt,
    getRunMessages: () => options.runMessages,
    graphRunnable: {
      getState: async () => {
        if (options.saved instanceof Error) {
          throw options.saved;
        }
        return { values: { messages: options.saved } };
      },
    },
  };
}

const history = [new HumanMessage('Erstelle die Mahnliste')];
const config = { version: 'v2' as const };
const answer = new AIMessage({ content: 'Ich habe angefangen.', id: 'ai-1' });

describe('plan arguments', () => {
  it('parses streamed JSON, normalizes statuses and ignores incomplete args', () => {
    expect(parsePlanArgs('{"schritte":[{"schritt":"A lesen","status":"läuft"}')).toBeNull();
    expect(
      parsePlanArgs({
        titel: '  Mahnlauf  ',
        schritte: [
          { schritt: 'A  lesen', status: 'läuft' },
          { schritt: 'B', status: 'done' },
          { schritt: '', status: 'offen' },
          { schritt: 'C', status: 'unbekannt' },
        ],
      }),
    ).toEqual({
      title: 'Mahnlauf',
      steps: [
        { text: 'A lesen', status: 'laeuft' },
        { text: 'B', status: 'erledigt' },
        { text: 'C', status: 'offen' },
      ],
    });
  });

  it('reads the newest complete plan of a turn', () => {
    const content = [
      ...DONE_PLAN,
      { type: 'text' },
      ...OPEN_PLAN,
      { type: 'tool_call', tool_call: { name: PLAN_TOOL_NAME, args: '{"schritte":[' } },
    ];
    expect(findLatestPlan(content)?.steps).toHaveLength(3);
    expect(findLatestPlan([{ type: 'text' }])).toBeNull();
  });

  it('answers the model with a short progress line', async () => {
    const input = { schritte: [{ schritt: 'A', status: 'erledigt' as const }] };
    expect(describePlanUpdate(input)).toBe('Plan gespeichert: alle 1 Schritte erledigt.');
    const result = await createPlanTool().invoke({
      schritte: [
        { schritt: 'A', status: 'erledigt' },
        { schritt: 'B', status: 'laeuft' },
      ],
    });
    expect(result).toContain('1 von 2');
  });
});

describe('continueOpenPlan (stop reminder)', () => {
  it('runs one more pass with the full history when nothing is stored', async () => {
    const run = fakeRun({ runMessages: [answer], saved: [] });
    const ran = await continueOpenPlan({ run, messages: history, config, contentParts: OPEN_PLAN });
    expect(ran).toBe(true);
    expect(run.calls).toHaveLength(1);
    const [call] = run.calls;
    expect(call.keepContent).toBe(true);
    expect(call.messages.slice(0, 2)).toEqual([...history, answer]);
    const note = String(call.messages[2].content);
    expect(note).toContain('<system-hinweis>');
    expect(note).toContain('- Mahnliste erstellen');
    expect(note).toContain('- Entwurf schreiben');
    expect(note).not.toContain('Rechnungen lesen');
  });

  it('sends only the reminder when the checkpoint already holds the finished pass', async () => {
    const run = fakeRun({ runMessages: [answer], saved: [...history, answer] });
    await continueOpenPlan({ run, messages: history, config, contentParts: OPEN_PLAN });
    expect(run.calls[0].messages).toHaveLength(1);
  });

  it('falls back to the full history when no checkpointer exists', async () => {
    const run = fakeRun({ runMessages: [answer], saved: new Error('No checkpointer set') });
    await continueOpenPlan({ run, messages: history, config, contentParts: OPEN_PLAN });
    expect(run.calls[0].messages).toHaveLength(3);
  });

  it('skips on inconsistent stored state, pause, halt, abort, done or missing plans', async () => {
    const cases: Array<[ReturnType<typeof fakeRun>, unknown[], AbortSignal | undefined]> = [
      [
        fakeRun({ runMessages: [answer], saved: [new AIMessage({ content: 'x', id: 'other' })] }),
        OPEN_PLAN,
        undefined,
      ],
      [fakeRun({ runMessages: [answer], interrupt: { payload: {} } }), OPEN_PLAN, undefined],
      [fakeRun({ runMessages: [answer], halt: 'hook' }), OPEN_PLAN, undefined],
      [fakeRun({ runMessages: [answer] }), OPEN_PLAN, AbortSignal.abort()],
      [fakeRun({ runMessages: [answer] }), DONE_PLAN, undefined],
      [fakeRun({ runMessages: [answer] }), [{ type: 'text' }], undefined],
      [fakeRun({ runMessages: [] }), OPEN_PLAN, undefined],
    ];
    for (const [run, contentParts, signal] of cases) {
      const ran = await continueOpenPlan({
        run,
        messages: history,
        config,
        contentParts: contentParts as typeof OPEN_PLAN,
        signal,
      });
      expect(ran).toBe(false);
      expect(run.calls).toHaveLength(0);
    }
  });

  it('builds a reminder that lists only open steps', () => {
    const plan = findLatestPlan(OPEN_PLAN);
    expect(plan).not.toBeNull();
    expect(buildPlanReminder(plan!)).toMatch(/^<system-hinweis>[\s\S]*<\/system-hinweis>$/);
  });
});

describe('buildChatGuidance', () => {
  const withTools = { tools: [], toolDefinitions: [{ name: 'web_search' }] };

  it('offers plan and next steps to the primary chat agent with tools', () => {
    const guidance = buildChatGuidance({ agent: withTools, chat: true, primary: true });
    expect(guidance.tools.map((tool) => tool.name)).toEqual([PLAN_TOOL_NAME]);
    expect(guidance.instructions).toContain('plan_aktualisieren');
    expect(guidance.instructions).toContain('<naechste_schritte>');
  });

  it('keeps the plan away from tool-less, secondary and non-chat agents', () => {
    const askOnly = { toolDefinitions: [{ name: 'ask_user_question' }] };
    expect(buildChatGuidance({ agent: askOnly, chat: true, primary: true }).tools).toEqual([]);
    expect(buildChatGuidance({ agent: withTools, chat: true, primary: false }).tools).toEqual([]);
    expect(buildChatGuidance({ agent: withTools, chat: false, primary: true })).toEqual({
      instructions: '',
      tools: [],
    });
  });

  it('honors the endpoint switches', () => {
    const appConfig = { endpoints: { agents: { nextSteps: false, plan: false } } } as Parameters<
      typeof buildChatGuidance
    >[0]['appConfig'];
    expect(buildChatGuidance({ agent: withTools, appConfig, chat: true, primary: true })).toEqual({
      instructions: '',
      tools: [],
    });
  });
});
