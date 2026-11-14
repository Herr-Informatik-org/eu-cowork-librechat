import { createNextStepsSink, resolveNextSteps } from './sink';
import type { TextDeltaEvent } from './sink';

const delta = (id: string, text: string): TextDeltaEvent => ({
  id,
  delta: { content: [{ type: 'text', text }] },
});

const textOf = (data: TextDeltaEvent | null): string => {
  const content = data?.delta?.content;
  if (content == null) {
    return '';
  }
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((part) => part.text ?? '').join('');
};

describe('createNextStepsSink', () => {
  it('filters the block out of deltas and returns validated steps', async () => {
    const sink = createNextStepsSink<{ node: string }>();
    const forwarded: string[] = [];
    sink.bind(async (data) => {
      forwarded.push(textOf(data));
    });
    const chunks = [
      'Die Offerte ist geprüft.',
      '\n\n<naechste_',
      'schritte>\nVergleiche die Offerte mit 2024\nSchreibe Herrn Keller: …\n</naechste',
      '_schritte>',
    ];
    const visible = chunks.map((chunk) => textOf(sink.filter(delta('step_1', chunk))));
    await sink.flush();
    expect(visible.join('') + forwarded.join('')).toBe('Die Offerte ist geprüft.');
    expect(sink.take('Prüfe die Offerte')).toEqual([
      { text: 'Vergleiche die Offerte mit 2024' },
      { text: 'Schreibe Herrn Keller:', needsInput: true },
    ]);
  });

  it('returns null for deltas that become empty and keeps non-text parts', () => {
    const sink = createNextStepsSink();
    expect(sink.filter(delta('s', '<naechste_schritte>\nFasse das zusammen'))).toBeNull();
    const mixed = sink.filter({
      id: 'r',
      delta: { content: [{ type: 'think' }, { type: 'text', text: 'Hallo' }] },
    });
    expect(mixed?.delta?.content).toEqual([{ type: 'think' }, { type: 'text', text: 'Hallo' }]);
    const untouched = { id: 'x', delta: { content: [{ type: 'think' }] } };
    expect(sink.filter(untouched)).toBe(untouched);
  });

  it('ignores a block that is followed by a tool call', async () => {
    const sink = createNextStepsSink();
    sink.filter(
      delta(
        'a',
        'Ich suche.\n<naechste_schritte>\nFasse die Treffer zusammen\n</naechste_schritte>',
      ),
    );
    await sink.onRunStep('tool', true);
    expect(sink.take()).toBeUndefined();
    sink.filter(
      delta(
        'b',
        'Gefunden.\n<naechste_schritte>\nZeige die Treffer als Tabelle\n</naechste_schritte>',
      ),
    );
    expect(sink.take()).toEqual([{ text: 'Zeige die Treffer als Tabelle' }]);
  });

  it('yields nothing for a truncated block and no block at all', async () => {
    const truncated = createNextStepsSink();
    truncated.filter(delta('a', 'Antwort.\n<naechste_schritte>\nFasse das Protok'));
    await truncated.flush();
    expect(truncated.take()).toBeUndefined();

    const none = createNextStepsSink();
    none.filter(delta('a', 'Nur Text.'));
    await none.flush();
    expect(none.take()).toBeUndefined();
  });

  it('releases a held tail of an earlier step when a new step begins', async () => {
    const sink = createNextStepsSink<string>();
    const forwarded: Array<[string | undefined, string, string | undefined]> = [];
    sink.bind(async (data, metadata) => {
      forwarded.push([data.id, textOf(data), metadata]);
    });
    expect(textOf(sink.filter(delta('a', 'Ich prüfe <'), 'meta-a'))).toBe('Ich prüfe');
    await sink.onRunStep('b', true);
    expect(forwarded).toEqual([['a', ' <', 'meta-a']]);
  });
});

describe('resolveNextSteps', () => {
  const finished = () => {
    const sink = createNextStepsSink();
    sink.filter(
      delta(
        'a',
        'Fertig.\n<naechste_schritte>\nFasse die Ergebnisse zusammen\n</naechste_schritte>',
      ),
    );
    return sink;
  };
  const openPlan = {
    type: 'tool_call',
    tool_call: {
      name: 'plan_aktualisieren',
      args: '{"schritte":[{"schritt":"A","status":"erledigt"},{"schritt":"B","status":"offen"}]}',
    },
  };

  it('returns the steps of a turn that finished on its own', () => {
    expect(resolveNextSteps({ sink: finished(), contentParts: [] })).toEqual([
      { text: 'Fasse die Ergebnisse zusammen' },
    ]);
  });

  it('withholds them after a pause, stop, error or with an open plan', () => {
    expect(resolveNextSteps({ sink: finished(), paused: true })).toBeUndefined();
    expect(resolveNextSteps({ sink: finished(), stopped: true })).toBeUndefined();
    expect(
      resolveNextSteps({ sink: finished(), contentParts: [{ type: 'error' }] }),
    ).toBeUndefined();
    expect(resolveNextSteps({ sink: finished(), contentParts: [openPlan] })).toBeUndefined();
    expect(resolveNextSteps({ sink: null })).toBeUndefined();
  });
});

it('keeps a terminal question reply with an open plan, without leaking its marker', async () => {
  const sink = createNextStepsSink();
  const visible = textOf(
    sink.filter(
      delta(
        'reply',
        'Soll ich mit AarPower AG beginnen?\n<naechste_schritte>\nANTWORT: Ja, beginne bitte mit AarPower AG.\n</naechste_schritte>',
      ),
    ),
  );
  await sink.flush();
  expect(visible).toBe('Soll ich mit AarPower AG beginnen?');
  const contentParts = [
    {
      type: 'tool_call',
      tool_call: {
        name: 'plan_aktualisieren',
        args: { schritte: [{ schritt: 'Weiterarbeiten', status: 'offen' }] },
      },
    },
  ];
  const params = { sink, contentParts };
  expect(resolveNextSteps(params)?.[0].kind).toBe('reply');
  expect(resolveNextSteps({ ...params, stopped: true })).toBeUndefined();
  expect(resolveNextSteps({ ...params, paused: true })).toBeUndefined();
});
