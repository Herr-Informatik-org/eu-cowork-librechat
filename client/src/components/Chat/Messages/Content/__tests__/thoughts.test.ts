import { ContentTypes, isPlanToolPart } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { PartWithIndex } from '../ParallelContent';
import { groupSequentialToolCalls } from '~/utils/groupToolCalls';
import {
  thoughtText,
  isHiddenPart,
  lastShownIdx,
  tailThoughtIdx,
  runningPlanStep,
  mergeThoughtRuns,
  latestThoughtHeading,
} from '../thoughts';

const think = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think: text }) as TMessageContentParts;

const text = (value: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;

const tool = (name: string, args: unknown = '{}', id = name): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    tool_call: { id, name, args: typeof args === 'string' ? args : JSON.stringify(args) },
  }) as unknown as TMessageContentParts;

const plan = (running: string, id: string): TMessageContentParts =>
  tool(
    'plan_aktualisieren',
    {
      titel: 'Analyse und Word-Bericht zum Preismodell',
      schritte: [
        { schritt: 'Datenbasis, Struktur und verfügbare Zugriffe prüfen', status: 'erledigt' },
        { schritt: running, status: 'laeuft' },
        { schritt: 'Word-Bericht erstellen', status: 'offen' },
      ],
    },
    id,
  );

/** The stored message from the report: five reasoning segments split by plan updates. */
const REPORTED: TMessageContentParts[] = [
  think('first'),
  plan('Preislogik, Entwicklung und Potenzial berechnen', 'p1'),
  think('second'),
  plan('Preislogik, Entwicklung und Potenzial berechnen', 'p2'),
  think('third'),
  plan('Preislogik, Entwicklung und Potenzial berechnen', 'p3'),
  think('fourth'),
  plan('Word-Bericht erstellen', 'p4'),
  think('fifth'),
  tool('create_file'),
  text('answer'),
  plan('Word-Bericht erstellen', 'p5'),
  text('closing'),
];

/** Mirrors ContentParts: plan parts never reach the grouping step. */
const visibleParts = (content: TMessageContentParts[]): PartWithIndex[] =>
  content.flatMap((part, idx) => (isPlanToolPart(part) ? [] : [{ part, idx }]));

const group = (content: TMessageContentParts[]) =>
  mergeThoughtRuns(groupSequentialToolCalls(visibleParts(content)));

describe('thoughts', () => {
  it('merges reasoning split only by hidden plan updates into one run', () => {
    const groups = group(REPORTED);

    expect(groups.map((g) => g.type)).toEqual(['thoughts', 'single', 'single', 'single']);
    const [run] = groups;
    expect(run.type === 'thoughts' && run.parts.map((p) => p.idx)).toEqual([0, 2, 4, 6, 8]);
    expect(run.type === 'thoughts' && run.text).toBe('first\n\nsecond\n\nthird\n\nfourth\n\nfifth');
  });

  it('lets a visible tool call end the run', () => {
    const groups = group([think('a'), tool('create_file'), think('b')]);
    expect(groups.map((g) => g.type)).toEqual(['thoughts', 'single', 'thoughts']);
  });

  it('drops empty text between reasoning parts but keeps empty text after the run', () => {
    const groups = group([think('a'), text(''), think('b'), text(' ')]);
    expect(groups.map((g) => g.type)).toEqual(['thoughts', 'single']);
    expect(groups[0].type === 'thoughts' && groups[0].text).toBe('a\n\nb');
  });

  it('strips think tags and skips empty segments', () => {
    expect(thoughtText(think('<think>  inner </think>'))).toBe('inner');
    expect(thoughtText(text('no'))).toBe('');
    const groups = group([think('<think>a</think>'), think(''), think('b')]);
    expect(groups[0].type === 'thoughts' && groups[0].text).toBe('a\n\nb');
  });

  it('treats plan updates, blank labels and empty text as hidden', () => {
    expect(isHiddenPart(undefined)).toBe(true);
    expect(isHiddenPart(plan('x', 'p'))).toBe(true);
    expect(isHiddenPart(text('  '))).toBe(true);
    expect(
      isHiddenPart({
        type: ContentTypes.ACTIVITY_LABEL,
        activity_label: '',
      } as TMessageContentParts),
    ).toBe(true);
    expect(
      isHiddenPart({
        type: ContentTypes.ACTIVITY_LABEL,
        activity_label: 'Reading files',
      } as TMessageContentParts),
    ).toBe(false);
    expect(isHiddenPart(think(''))).toBe(true);
    expect(isHiddenPart(think('a'))).toBe(false);
    expect(isHiddenPart(tool('create_file'))).toBe(false);
  });

  it('finds the last shown part past trailing plan updates', () => {
    expect(lastShownIdx([think('a'), plan('x', 'p')])).toBe(0);
    expect(lastShownIdx([plan('x', 'p'), text('')])).toBe(-1);
    expect(lastShownIdx(undefined)).toBe(-1);
    expect(lastShownIdx(REPORTED)).toBe(12);
  });

  it('reports the run at the end of the content as the live one', () => {
    expect(tailThoughtIdx(group([think('a'), plan('x', 'p'), think('b'), plan('y', 'q')]))).toBe(2);
    expect(tailThoughtIdx(group([think('a'), text('')]))).toBe(0);
    expect(tailThoughtIdx(group([think('a'), tool('create_file')]))).toBe(-1);
    expect(tailThoughtIdx(group(REPORTED))).toBe(-1);
  });

  it('reads the running step of the newest complete plan', () => {
    expect(runningPlanStep(REPORTED)).toBe('Word-Bericht erstellen');
    expect(
      runningPlanStep([plan('Daten prüfen', 'p'), tool('plan_aktualisieren', '{"schri')]),
    ).toBe('Daten prüfen');
    expect(runningPlanStep([think('a')])).toBeUndefined();
  });

  it('reads the newest bold summary heading', () => {
    const summary = '**Checking the data**\n\nLooking at rows.\n\n**Comparing  prices**\n\nMore.';
    expect(latestThoughtHeading(summary)).toBe('Comparing prices');
    expect(latestThoughtHeading('No heading, but **bold** inline.')).toBeUndefined();
    expect(latestThoughtHeading('**Unfinished head')).toBeUndefined();
  });
});
