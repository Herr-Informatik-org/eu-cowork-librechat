import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BrainRecallUsage, TMessage } from 'librechat-data-provider';
import BrainUsage from '../Usage';

let mockUsage: BrainRecallUsage | undefined;
let mockEnabled = true;
let mockCanUpdate = true;
let mockUpdateError = false;
const mockRefetch = jest.fn();
const mockMutate = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values: { count?: number } = {}) =>
      values.count === undefined ? key : `${key}:${values.count}`,
  useHasAccess: ({ permission }: { permission: string }) =>
    permission === 'UPDATE' ? mockCanUpdate : true,
}));
jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
}));
jest.mock('~/data-provider/Brain', () => ({
  useBrainStatusQuery: () => ({ data: { enabled: mockEnabled } }),
  useBrainRecallUsageQuery: (_conversationId: string, enabled: boolean) => ({
    data: enabled ? mockUsage : undefined,
    refetch: mockRefetch,
  }),
  useBrainMutations: () => ({
    update: { mutate: mockMutate, isLoading: false, isError: mockUpdateError },
  }),
}));

const answer = {
  messageId: 'answer-1',
  conversationId: 'chat-1',
  isCreatedByUser: false,
  createdAt: '2026-01-01T00:00:00.000Z',
} as TMessage;

const usage: BrainRecallUsage = {
  messages: [{ messageId: 'answer-1', nodeIds: ['style', 'rate'] }],
  nodes: [
    {
      id: 'style',
      title: 'Kundenbriefe in der Sie-Form',
      kind: 'preference',
      scope: null,
      status: 'active',
      confidence: 'confirmed',
      version: 3,
      sources: [
        {
          type: 'chat',
          label: 'Eigener Chatbeitrag',
          conversationId: 'chat-0',
          createdAt: '2026-10-01T08:00:00.000Z',
        },
      ],
    },
    {
      id: 'rate',
      title: 'Stundensatz 140 Franken',
      kind: 'fact',
      scope: null,
      status: 'superseded',
      confidence: 'confirmed',
      version: 2,
      sources: [
        { type: 'manual', label: 'Manuell bestätigt', createdAt: '2026-10-02T08:00:00.000Z' },
      ],
    },
  ],
};

beforeEach(() => {
  mockUsage = usage;
  mockEnabled = true;
  mockCanUpdate = true;
  mockUpdateError = false;
  mockRefetch.mockReset();
  mockMutate.mockReset();
});

it('shows a collapsed chip with the number of memories the answer used', () => {
  render(<BrainUsage message={answer} />);
  const chip = screen.getByRole('button', { name: /com_ui_brain_usage:2/ });
  expect(chip).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Kundenbriefe in der Sie-Form')).not.toBeInTheDocument();
  fireEvent.click(chip);
  expect(chip).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Kundenbriefe in der Sie-Form')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Eigener Chatbeitrag/ })).toHaveAttribute(
    'href',
    '/c/chat-0',
  );
  expect(screen.getByText(/com_ui_brain_usage_manual/)).toBeInTheDocument();
  expect(screen.getByText('com_ui_brain_usage_outdated')).toBeInTheDocument();
});

it('marks a memory as outdated with its current version', () => {
  render(<BrainUsage message={answer} />);
  fireEvent.click(screen.getByRole('button', { name: /com_ui_brain_usage:2/ }));
  const actions = screen.getAllByRole('button', { name: 'com_ui_brain_usage_outdated_action' });
  expect(actions).toHaveLength(1);
  fireEvent.click(actions[0]);
  expect(mockMutate).toHaveBeenCalledWith({
    id: 'style',
    data: { status: 'superseded', version: 3 },
  });
});

it('hides the correction without update permission and reports a failed update', () => {
  mockCanUpdate = false;
  const view = render(<BrainUsage message={answer} />);
  fireEvent.click(screen.getByRole('button', { name: /com_ui_brain_usage:2/ }));
  expect(screen.queryByText('com_ui_brain_usage_outdated_action')).not.toBeInTheDocument();
  view.unmount();
  mockCanUpdate = true;
  mockUpdateError = true;
  render(<BrainUsage message={answer} />);
  fireEvent.click(screen.getByRole('button', { name: /com_ui_brain_usage:2/ }));
  expect(screen.getAllByRole('alert')[0]).toHaveTextContent('com_ui_brain_usage_error');
});

it('renders nothing for user messages, running answers, disabled Brain or answers without recall', () => {
  const { container, rerender } = render(
    <BrainUsage message={{ ...answer, isCreatedByUser: true }} />,
  );
  expect(container).toBeEmptyDOMElement();
  rerender(<BrainUsage message={answer} isSubmitting />);
  expect(container).toBeEmptyDOMElement();
  mockEnabled = false;
  rerender(<BrainUsage message={{ ...answer }} />);
  expect(container).toBeEmptyDOMElement();
  mockEnabled = true;
  rerender(<BrainUsage message={{ ...answer, messageId: 'answer-without-recall' }} />);
  expect(container).toBeEmptyDOMElement();
  expect(mockRefetch).not.toHaveBeenCalled();
});

it('refetches once for a fresh answer whose recall is not loaded yet', () => {
  const fresh = { ...answer, messageId: 'fresh', createdAt: new Date().toISOString() };
  const { rerender } = render(<BrainUsage message={fresh} />);
  rerender(<BrainUsage message={{ ...fresh }} />);
  expect(mockRefetch).toHaveBeenCalledTimes(1);
});
