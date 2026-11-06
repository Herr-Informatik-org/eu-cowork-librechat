import React from 'react';
import { render, screen } from '@testing-library/react';
import ProposalOutcome from '../ProposalOutcome';
import { rememberDecision, resetDecisionCache } from '../decisions';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    ({
      com_ui_proposal_planned: 'Nur geplant',
      com_ui_proposal_approved: 'Übernommen',
      com_ui_proposal_rejected: 'Verworfen',
      com_ui_proposal_title_delete: 'Datensatz löschen',
      com_ui_proposal_critical: 'Löscht, sendet oder führt etwas aus',
    })[key] ?? key,
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPServerNames: () => ['crm'],
}));

const NAME = 'delete_record_mcp_crm';
const ARGS = { model: 'crm.lead', record_id: 3, reason: 'Dublette' };

beforeEach(() => {
  window.localStorage.clear();
  resetDecisionCache();
});

describe('ProposalOutcome', () => {
  test('a plan-mode block shows the full proposal as «Nur geplant»', () => {
    render(
      <ProposalOutcome
        toolCallId="c1"
        name={NAME}
        args={ARGS}
        output="Blocked: Arbeitsmodus Planen: Diese Änderung wurde nicht ausgeführt."
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Nur geplant');
    expect(screen.getByRole('heading', { name: 'Datensatz löschen' })).toBeInTheDocument();
    expect(screen.getByText('Dublette')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Löscht, sendet oder führt etwas aus' })).toBeVisible();
  });

  test('a remembered approval stays visible as a compact record', () => {
    rememberDecision('c2', 'approved');
    render(<ProposalOutcome toolCallId="c2" name={NAME} args={ARGS} output='{"ok":true}' />);
    expect(screen.getByRole('status')).toHaveTextContent('Übernommen');
    expect(screen.queryByText('Dublette')).not.toBeInTheDocument();
  });

  test('ordinary tool results render nothing', () => {
    const { container } = render(
      <ProposalOutcome toolCallId="c3" name={NAME} args={ARGS} output='{"ok":true}' />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
