import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TSubmission } from 'librechat-data-provider';
import {
  clearConversationActivities,
  beginConversationActivity,
  finishConversationActivity,
} from '~/store/activity';
import PendingResponse, { pendingLabel } from '../PendingResponse';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const CONVO = 'convo-1';

const submission = {
  conversation: { conversationId: CONVO },
  initialResponse: { messageId: 'response-1' },
  userMessage: { messageId: 'user-1' },
} as unknown as TSubmission;

function Harness() {
  const setCreatedAt = useSetRecoilState(store.activeGenerationCreatedAtByConvoId(CONVO));
  return (
    <>
      <button type="button" aria-label="accept" onClick={() => setCreatedAt(Date.now())} />
      <PendingResponse conversationId={CONVO} />
    </>
  );
}

const renderPending = () =>
  render(
    <RecoilRoot>
      <Harness />
    </RecoilRoot>,
  );

describe('pendingLabel', () => {
  it('prepares until the server accepts, then thinks and grows patient', () => {
    expect(pendingLabel(false, 0)).toBe('com_ui_response_preparing');
    expect(pendingLabel(false, 30_000)).toBe('com_ui_response_preparing');
    expect(pendingLabel(true, 1_000)).toBe('com_ui_thinking');
    expect(pendingLabel(true, 15_000)).toBe('com_ui_thinking_long');
  });
});

describe('PendingResponse', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearConversationActivities();
  });
  afterEach(() => {
    cleanup();
    clearConversationActivities();
    jest.useRealTimers();
  });

  it('shows a labeled status right away, without a bare cursor', () => {
    renderPending();
    const pending = screen.getByTestId('pending-response');
    expect(pending).toHaveAttribute('data-phase', 'preparing');
    expect(pending).toHaveTextContent('com_ui_response_preparing');
    expect(pending.querySelector('.chat-activity-orbit')).toHaveAttribute('aria-hidden', 'true');
    expect(pending).not.toHaveTextContent(/\d+ s/);
  });

  it('switches to thinking once the server has accepted the request', () => {
    renderPending();
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    const pending = screen.getByTestId('pending-response');
    expect(pending).toHaveAttribute('data-phase', 'started');
    /** The previous label stays briefly so a fast phase does not flicker past. */
    act(() => {
      jest.advanceTimersByTime(650);
    });
    expect(pending).toHaveTextContent('com_ui_thinking');
  });

  it('counts seconds from when the request was sent', () => {
    beginConversationActivity(submission);
    act(() => {
      jest.advanceTimersByTime(4_000);
    });
    renderPending();
    expect(screen.getByTestId('pending-response')).toHaveTextContent('4 s');
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('pending-response')).toHaveTextContent('5 s');
  });

  it('counts from its own start when the run is not tracked as active', () => {
    beginConversationActivity(submission);
    finishConversationActivity(submission, { conversationId: CONVO, final: true });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    renderPending();
    expect(screen.getByTestId('pending-response')).not.toHaveTextContent(/\d+ s/);
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId('pending-response')).toHaveTextContent('3 s');
  });
});
