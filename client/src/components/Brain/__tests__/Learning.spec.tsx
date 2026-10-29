import React from 'react';
import { render, screen } from '@testing-library/react';
import Learning from '../Learning';
import type { BrainLearningStatus } from 'librechat-data-provider';
let mockStatus: BrainLearningStatus | undefined;
let mockError = false;
jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'current-chat' }) }));
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values: { count?: number } = {}) =>
      `${key}:${values.count ?? ''}`,
}));
jest.mock('~/data-provider/Brain', () => ({
  useBrainLearningQuery: () => ({ data: mockStatus, isError: mockError }),
}));
beforeEach(() => {
  mockStatus = undefined;
  mockError = false;
});
it('distinguishes completed review with no new facts from an unverified failure', () => {
  mockStatus = { status: 'completed', saved: 0 };
  const view = render(<Learning />);
  expect(screen.getByText('com_ui_brain_learning_unchanged:0')).toBeInTheDocument();
  mockStatus = {
    status: 'failed',
    saved: 0,
    errorCode: 'review_missing_capture',
    incidentId: 'incident',
  };
  view.rerender(<Learning />);
  expect(screen.getByText('com_ui_brain_learning_failed:0')).toBeInTheDocument();
  expect(screen.getByText('review_missing_capture · incident')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_brain_learning_unchanged:0')).not.toBeInTheDocument();
});
it('shows an interrupted worker without presenting it as finished learning', () => {
  mockStatus = { status: 'interrupted', saved: 0 };
  render(<Learning />);
  expect(screen.getByText('com_ui_brain_learning_interrupted:0')).toBeInTheDocument();
});
it('does not show a cached success as current when the status cannot be verified', () => {
  mockStatus = { status: 'completed', saved: 3 };
  mockError = true;
  render(<Learning />);
  expect(screen.getByText('com_ui_brain_learning_unavailable:3')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_brain_learning_saved:3')).not.toBeInTheDocument();
});
