import React, { useEffect } from 'react';
import { RecoilRoot } from 'recoil';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SystemRoles, PROPOSAL_REJECTED_REASON } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import ApprovalProvider, { useApprovalContext } from '../ApprovalContext';
import ToolApproval from '../ToolApproval';

const mockSubmit = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string | number>) => {
    const map: Record<string, string> = {
      com_ui_proposal_approve: 'Übernehmen',
      com_ui_proposal_reject: 'Verwerfen',
      com_ui_proposal_approved: 'Übernommen',
      com_ui_proposal_rejected: 'Verworfen',
      com_ui_proposal_expired: 'Abgelaufen',
      com_ui_proposal_title_update: 'Datensatz ändern',
      com_ui_proposal_target: 'Ziel',
      com_ui_proposal_values: 'Werte',
      com_ui_proposal_field_phone: 'Telefon',
      com_ui_edit: 'Bearbeiten',
      com_ui_submitting: 'Wird gesendet',
      com_ui_yes: 'Ja',
      com_ui_no: 'Nein',
    };
    if (key === 'com_ui_proposal_submit_n') {
      return `${values?.[0]} Entscheide senden`;
    }
    if (key === 'com_ui_proposal_record') {
      return `Nr. ${values?.[0]}`;
    }
    if (key === 'com_ui_via_server') {
      return `in ${values?.[0]}`;
    }
    return map[key] ?? key;
  },
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPServerNames: () => ['odoo-admin'],
}));

jest.mock('~/hooks/AuthContext', () => ({
  AuthContext: jest.requireActual('react').createContext(undefined),
}));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/Providers/ChatContext', () => ({
  ChatContext: jest.requireActual('react').createContext(null),
}));

jest.mock('../ApprovalContext', () => {
  const actual = jest.requireActual('../ApprovalContext');
  return {
    __esModule: true,
    ...actual,
    useResumeSubmit: () => ({ submitToolApproval: mockSubmit }),
  };
});

const UPDATE = 'update_record_mcp_odoo-admin';
const ARGS = {
  intent: 'Ändert die Telefonnummer von Anna Muster',
  model: 'res.partner',
  record_id: 7,
  values: { phone: '+41 44 000 00 00', is_company: false },
};

const approval = (
  allowed: Agents.ToolApprovalDecisionType[] = ['approve', 'reject'],
): NonNullable<Agents.ToolCall['approval']> => ({
  actionId: 'action-1',
  allowed_decisions: allowed,
  description: 'Dieser Schritt ändert Daten.',
});

type Ctx = ReturnType<typeof useApprovalContext>;
const ctxRef: { current: Ctx | null } = { current: null };

function Probe() {
  const ctx = useApprovalContext();
  useEffect(() => {
    ctxRef.current = ctx;
  });
  return null;
}

const { AuthContext } = jest.requireMock('~/hooks/AuthContext') as {
  AuthContext: React.Context<unknown>;
};

const renderCards = (cards: React.ReactNode, role: string = SystemRoles.USER) =>
  render(
    <RecoilRoot>
      <AuthContext.Provider value={{ user: { role } }}>
        <ApprovalProvider>
          <Probe />
          {cards}
        </ApprovalProvider>
      </AuthContext.Provider>
    </RecoilRoot>,
  );

beforeEach(() => {
  mockSubmit.mockReset();
  window.localStorage.clear();
});

describe('ToolApproval as proposal card', () => {
  test('shows intent, target and readable values instead of JSON, without autofocus', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="c1" args={ARGS} name={UPDATE} />);

    expect(screen.getByRole('heading', { name: ARGS.intent })).toBeInTheDocument();
    expect(screen.getByText('res.partner · Nr. 7 · in odoo-admin')).toBeInTheDocument();
    expect(screen.getByText('Telefon')).toBeInTheDocument();
    expect(screen.getByText('+41 44 000 00 00')).toBeInTheDocument();
    expect(screen.getByText('Nein')).toBeInTheDocument();
    expect(screen.queryByText(/"values"/)).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Übernehmen' });
    expect(document.activeElement).not.toBe(approve);
  });

  test('a single paused call submits on «Übernehmen» and keeps a focused badge', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="c1" args={ARGS} name={UPDATE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(mockSubmit).toHaveBeenCalledWith('action-1');
    expect(ctxRef.current?.getDecisions('action-1')).toEqual([
      { tool_call_id: 'c1', decision: 'approve' },
    ]);

    act(() => ctxRef.current?.setStatus('action-1', 'submitted'));

    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Übernommen');
    expect(document.activeElement).toBe(badge);
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('kisuno:proposalDecisions')).toContain('approved');
  });

  test('«Verwerfen» sends the reject reason the card recognizes later', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="c1" args={ARGS} name={UPDATE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(ctxRef.current?.getDecisions('action-1')).toEqual([
      { tool_call_id: 'c1', decision: 'reject', reason: PROPOSAL_REJECTED_REASON },
    ]);
    act(() => ctxRef.current?.setStatus('action-1', 'submitted'));
    expect(screen.getByRole('status')).toHaveTextContent('Verworfen');
  });

  test('several paused calls share one submit that needs every decision', () => {
    renderCards(
      <>
        <ToolApproval approval={approval()} toolCallId="c1" args={ARGS} name={UPDATE} />
        <ToolApproval approval={approval()} toolCallId="c2" args={ARGS} name={UPDATE} />
      </>,
    );

    const submit = screen.getByRole('button', { name: '2 Entscheide senden' });
    expect(submit).toBeDisabled();
    const [first, second] = screen.getAllByRole('button', { name: 'Übernehmen' });
    fireEvent.click(first);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(submit).toBeDisabled();
    fireEvent.click(second);
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mockSubmit).toHaveBeenCalledWith('action-1');
  });

  test('editing is hidden for normal people and offered to administrators', () => {
    const { unmount } = renderCards(
      <ToolApproval
        approval={approval(['approve', 'reject', 'edit'])}
        toolCallId="c1"
        args={ARGS}
        name={UPDATE}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).not.toBeInTheDocument();
    unmount();

    renderCards(
      <ToolApproval
        approval={approval(['approve', 'reject', 'edit'])}
        toolCallId="c1"
        args={ARGS}
        name={UPDATE}
      />,
      SystemRoles.ADMIN,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Bearbeiten' }), {
      target: { value: '{"model":"res.partner","record_id":7}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(ctxRef.current?.getDecisions('action-1')).toEqual([
      {
        tool_call_id: 'c1',
        decision: 'edit',
        editedArguments: { model: 'res.partner', record_id: 7 },
      },
    ]);
  });

  test('an expired proposal shows its badge and no actions', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="c1" args={ARGS} name={UPDATE} />);
    act(() => ctxRef.current?.setStatus('action-1', 'expired'));
    expect(screen.getByText('Abgelaufen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).not.toBeInTheDocument();
  });
});
