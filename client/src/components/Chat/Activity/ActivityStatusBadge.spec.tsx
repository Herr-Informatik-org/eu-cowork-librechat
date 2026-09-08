import { render, screen } from '@testing-library/react';
import type { ConversationActivity } from '~/store/activity';
import ActivityStatusBadge from './ActivityStatusBadge';
import { useConversationActivity } from './useActivity';

jest.mock('./useActivity', () => ({ useConversationActivity: jest.fn() }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));

const observed = jest.mocked(useConversationActivity);
const activity = (state: ConversationActivity['state']): ConversationActivity => ({
  conversationId: 'chat',
  runId: 'run',
  state,
  stage: 'thinking',
  startedAt: 1,
  updatedAt: 2,
});

test('historical conversations without an observed result have no completion claim', () => {
  observed.mockReturnValue(null);
  const { container } = render(<ActivityStatusBadge conversationId="chat" active={false} />);
  expect(container).toBeEmptyDOMElement();
});

test('an active backend job provides a readable working state', () => {
  observed.mockReturnValue(null);
  render(<ActivityStatusBadge conversationId="chat" active />);
  expect(screen.getByText('com_ui_activity_thinking')).toBeVisible();
});

test('compact input requests retain their text label and distinct state', () => {
  observed.mockReturnValue(activity('needs-input'));
  render(<ActivityStatusBadge conversationId="chat" compact active={false} />);
  const label = screen.getByTitle('com_ui_activity_needs_input');
  expect(label).toHaveAttribute('data-state', 'needs-input');
  expect(screen.getByText('com_ui_activity_needs_input')).toHaveClass('sr-only');
});

test('an ended backend job cannot leave a stale running badge or invent success', () => {
  observed.mockReturnValue(activity('running'));
  const { container } = render(<ActivityStatusBadge conversationId="chat" active={false} />);
  expect(container).toBeEmptyDOMElement();
});

test('an observed final event has an explicit completed label', () => {
  observed.mockReturnValue(activity('done'));
  render(<ActivityStatusBadge conversationId="chat" active={false} />);
  expect(screen.getByText('com_ui_activity_done')).toBeVisible();
});
