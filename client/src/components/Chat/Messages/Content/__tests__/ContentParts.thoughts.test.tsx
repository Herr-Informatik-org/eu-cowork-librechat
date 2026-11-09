import React from 'react';
import { RecoilRoot } from 'recoil';
import { ContentTypes } from 'librechat-data-provider';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import ContentParts from '../ContentParts';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values?.time != null ? `${key} ${values.time}` : key,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useProgress: (initial: number) => (initial >= 1 ? 1 : initial),
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('../Part', () => ({
  __esModule: true,
  default: ({ part }: { part: TMessageContentParts }) => {
    const name = (part as { tool_call?: { name?: string } }).tool_call?.name;
    return <div data-testid="part" data-type={part.type} data-name={name} />;
  },
}));

jest.mock('../Parts', () => ({
  EditTextPart: () => <div data-testid="edit-text" />,
  AgentUpdate: () => <div data-testid="agent-update" />,
}));

jest.mock('../ToolCallGroup', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-group" />,
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => null,
}));

const think = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think: text }) as TMessageContentParts;

const text = (value: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;

const tool = (name: string, args = '{}', id = name): TMessageContentParts =>
  ({ type: ContentTypes.TOOL_CALL, tool_call: { id, name, args } }) as TMessageContentParts;

const plan = (running: string, id: string): TMessageContentParts =>
  tool(
    'plan_aktualisieren',
    JSON.stringify({
      titel: 'Analyse und Word-Bericht zum Preismodell',
      schritte: [
        { schritt: 'Datenbasis, Struktur und verfügbare Zugriffe prüfen', status: 'erledigt' },
        { schritt: running, status: 'laeuft' },
      ],
    }),
    id,
  );

const CALCULATE = 'Preislogik, Entwicklung und Potenzial berechnen';
const REPORT = 'Word-Bericht erstellen';

/** Part order of the reported response: plan updates split the reasoning five times. */
const REPORTED: TMessageContentParts[] = [
  think('Erster Gedanke'),
  plan(CALCULATE, 'p1'),
  think('Zweiter Gedanke'),
  plan(CALCULATE, 'p2'),
  think('Dritter Gedanke'),
  plan(CALCULATE, 'p3'),
  think('Vierter Gedanke'),
  plan(REPORT, 'p4'),
  think('Fünfter Gedanke'),
  tool('create_file'),
  text('Antwort'),
  plan(REPORT, 'p5'),
  text('Schluss'),
];

type Props = Partial<React.ComponentProps<typeof ContentParts>>;

const props = (overrides: Props): React.ComponentProps<typeof ContentParts> => ({
  messageId: 'msg-1',
  conversationId: 'convo-1',
  isCreatedByUser: false,
  isLast: true,
  isSubmitting: false,
  isLatestMessage: true,
  content: [],
  ...overrides,
});

const renderParts = (overrides: Props) => {
  const view = render(
    <RecoilRoot>
      <ContentParts {...props(overrides)} />
    </RecoilRoot>,
  );
  const rerender = (next: Props) =>
    view.rerender(
      <RecoilRoot>
        <ContentParts {...props(next)} />
      </RecoilRoot>,
    );
  return { ...view, rerender };
};

/** Header buttons of reasoning blocks (the copy button is the only other button there). */
const thoughtHeaders = () =>
  screen.queryAllByRole('button').filter((button) => button.hasAttribute('aria-controls'));

describe('ContentParts reasoning runs', () => {
  it('renders reasoning split by plan updates as one block with every segment in order', () => {
    renderParts({ content: REPORTED });

    const headers = thoughtHeaders();
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveTextContent('com_ui_thoughts');

    fireEvent.click(headers[0]);
    const body = document.getElementById(headers[0].getAttribute('aria-controls') ?? '');
    expect(body?.textContent).toBe(
      'Erster Gedanke\n\nZweiter Gedanke\n\nDritter Gedanke\n\nVierter Gedanke\n\nFünfter Gedanke',
    );

    const parts = screen.getAllByTestId('part');
    expect(parts.map((part) => part.dataset.name ?? part.dataset.type)).toEqual([
      'create_file',
      'text',
      'text',
    ]);
    expect(headers[0].compareDocumentPosition(parts[0])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps a visible tool call as the boundary between two blocks', () => {
    renderParts({ content: [think('a'), tool('create_file'), think('b')] });
    expect(thoughtHeaders()).toHaveLength(2);
  });

  describe('while the response streams', () => {
    it('names the running plan step and keeps one block as segments arrive', () => {
      const { rerender } = renderParts({
        isSubmitting: true,
        content: [think('Erster Gedanke'), plan(CALCULATE, 'p1')],
      });
      const [header] = thoughtHeaders();
      expect(header).toHaveTextContent(CALCULATE);
      expect(screen.getByText(CALCULATE)).toHaveClass('kisuno-shimmer');
      expect(screen.queryByTestId('pending-response')).toBeNull();

      rerender({
        isSubmitting: true,
        content: [...REPORTED.slice(0, 8), think('Fünfter')],
      });
      expect(thoughtHeaders()).toEqual([header]);
      expect(header).toHaveTextContent(REPORT);
    });

    it('falls back to the newest summary heading, then to the generic label', () => {
      const { rerender } = renderParts({
        isSubmitting: true,
        content: [think('**Mastertabelle lesen**\n\nIch öffne die Blätter.')],
      });
      expect(thoughtHeaders()[0]).toHaveTextContent('Mastertabelle lesen');

      rerender({ isSubmitting: true, content: [think('Ohne Überschrift')] });
      expect(thoughtHeaders()[0]).toHaveTextContent('com_ui_thinking');
    });

    it('shows the total duration of the merged block once visible output follows', () => {
      jest.useFakeTimers();
      try {
        const { rerender } = renderParts({
          isSubmitting: true,
          content: [think('Erster Gedanke'), plan(CALCULATE, 'p1')],
        });
        act(() => {
          jest.advanceTimersByTime(40_000);
        });
        rerender({ isSubmitting: true, content: REPORTED.slice(0, 8) });
        act(() => {
          jest.advanceTimersByTime(32_000);
        });
        rerender({ isSubmitting: true, content: REPORTED.slice(0, 10) });

        const headers = thoughtHeaders();
        expect(headers).toHaveLength(1);
        expect(headers[0]).toHaveTextContent('com_ui_thought_for 1 min 12 s');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('before the first visible content', () => {
    it('replaces the bare cursor with a labeled status', () => {
      renderParts({ isSubmitting: true, content: [] });
      const pending = screen.getByTestId('pending-response');
      expect(pending).toHaveTextContent('com_ui_response_preparing');
      expect(document.querySelector('.result-thinking')).toBeNull();
    });

    it('keeps the status while only a hidden plan update has arrived', () => {
      renderParts({ isSubmitting: true, content: [plan(CALCULATE, 'p1')] });
      expect(screen.getByTestId('pending-response')).toBeInTheDocument();
      expect(screen.queryByTestId('part')).toBeNull();
    });

    it('keeps the status until the first reasoning text arrives', () => {
      const { rerender } = renderParts({ isSubmitting: true, content: [think('')] });
      expect(screen.getByTestId('pending-response')).toBeInTheDocument();
      expect(thoughtHeaders()).toHaveLength(0);

      rerender({ isSubmitting: true, content: [think('Erster Gedanke')] });
      expect(screen.queryByTestId('pending-response')).toBeNull();
      expect(thoughtHeaders()).toHaveLength(1);
    });

    it('shows nothing once the run is over', () => {
      renderParts({ isSubmitting: false, content: [] });
      expect(screen.queryByTestId('pending-response')).toBeNull();
    });
  });
});
