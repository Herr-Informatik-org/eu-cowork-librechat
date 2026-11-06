import { render, screen, fireEvent } from '@testing-library/react';
import { PLAN_TOOL_NAME } from 'librechat-data-provider';
import type { TMessage, TPlan } from 'librechat-data-provider';
import { selectTailPlan, stepDisplay, currentStep } from '../model';
import { PlanPanel } from '../PlanBar';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options?: Record<string, string>): string =>
      options ? `${key}:${Object.values(options).join('/')}` : key,
}));
jest.mock('~/hooks/Messages/useLatestMessage', () => ({ useLatestMessageSelect: () => null }));

const plan = (statuses: Array<'offen' | 'laeuft' | 'erledigt'>, title?: string): TPlan => ({
  ...(title ? { title } : {}),
  steps: statuses.map((status, index) => ({ text: `Schritt ${index + 1}`, status })),
});

const renderPanel = (value: TPlan, live = true, messageId = 'resp-1') =>
  render(<PlanPanel snapshot={{ messageId, plan: value }} live={live} />);

const head = (): HTMLElement => document.querySelector('.kisuno-plan-head') as HTMLElement;

describe('PlanPanel', () => {
  it('shows progress, folds completed steps and glosses the running one', () => {
    const { container } = renderPanel(plan(['erledigt', 'erledigt', 'laeuft', 'offen', 'offen']));
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    const rows = container.querySelectorAll('.kisuno-plan-step');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveAttribute('data-folded', 'true');
    expect(rows[2]).toHaveAttribute('data-state', 'running');
    expect(rows[2].querySelector('.kisuno-shimmer')).toHaveTextContent('Schritt 3');
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_plan_progress:2/5');
  });

  it('reveals completed steps on request', () => {
    const { container } = renderPanel(plan(['erledigt', 'laeuft', 'offen']));
    fireEvent.click(screen.getByText('com_ui_plan_show_done:1'));
    expect(container.querySelector('.kisuno-plan-step')).not.toHaveAttribute('data-folded');
    expect(screen.getByText('com_ui_plan_hide_done')).toBeInTheDocument();
  });

  it('pauses a running step once the turn ends', () => {
    const { container } = renderPanel(plan(['erledigt', 'laeuft']), false);
    const running = container.querySelectorAll('.kisuno-plan-step')[1];
    expect(running).toHaveAttribute('data-state', 'paused');
    expect(container.querySelector('.kisuno-shimmer')).toBeNull();
  });

  it('collapses when everything is done and names the current step when closed', () => {
    const { rerender } = renderPanel(plan(['erledigt', 'erledigt'], 'Mahnlauf'));
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Mahnlauf')).toBeInTheDocument();

    rerender(
      <PlanPanel snapshot={{ messageId: 'resp-1', plan: plan(['erledigt', 'laeuft']) }} live />,
    );
    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.kisuno-plan-current')).toHaveTextContent('Schritt 2');
  });

  it('reopens and forgets the manual choice for an extended or new plan', () => {
    const { rerender } = renderPanel(plan(['laeuft', 'offen']));
    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <PlanPanel
        snapshot={{ messageId: 'resp-1', plan: plan(['erledigt', 'laeuft', 'offen']) }}
        live
      />,
    );
    expect(head()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(head());
    rerender(
      <PlanPanel snapshot={{ messageId: 'resp-2', plan: plan(['laeuft', 'offen']) }} live />,
    );
    expect(head()).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('plan model', () => {
  const planPart = {
    type: 'tool_call',
    tool_call: {
      id: 'call_1',
      name: PLAN_TOOL_NAME,
      args: '{"titel":"Offerte","schritte":[{"schritt":"Lesen","status":"erledigt"},{"schritt":"Prüfen","status":"laeuft"}]}',
    },
  };

  it('reads the plan from the response at the branch tail only', () => {
    const response = {
      messageId: 'r',
      isCreatedByUser: false,
      content: [planPart],
    } as unknown as TMessage;
    expect(selectTailPlan(response)?.plan.title).toBe('Offerte');
    expect(selectTailPlan({ ...response, isCreatedByUser: true } as TMessage)).toBeNull();
    expect(selectTailPlan({ ...response, content: [] } as unknown as TMessage)).toBeNull();
    expect(selectTailPlan(null)).toBeNull();
  });

  it('maps statuses for display and finds the current step', () => {
    const value = plan(['erledigt', 'offen', 'offen']);
    expect(stepDisplay(value.steps[0], true)).toBe('done');
    expect(stepDisplay({ text: 'x', status: 'laeuft' }, true)).toBe('running');
    expect(stepDisplay({ text: 'x', status: 'laeuft' }, false)).toBe('paused');
    expect(currentStep(value)?.text).toBe('Schritt 2');
  });
});
