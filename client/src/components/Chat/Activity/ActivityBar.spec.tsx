import { act, renderHook } from '@testing-library/react';
import type { ConversationActivity } from '~/store/activity';
import { liveActivityLabel } from './ActivityBar';
import useHeld from './useHeld';

jest.mock('./useActivity', () => ({ useActivityTracking: () => ({ activity: null }) }));
jest.mock('~/hooks/MCP', () => ({ useMCPServerNames: () => [] }));

const base: ConversationActivity = {
  conversationId: 'chat',
  runId: 'run',
  state: 'running',
  stage: 'thinking',
  startedAt: 0,
  updatedAt: 0,
};

describe('liveActivityLabel', () => {
  it('becomes more patient while thinking takes longer', () => {
    expect(liveActivityLabel(base, 3_000)).toBe('com_ui_activity_thinking');
    expect(liveActivityLabel(base, 15_000)).toBe('com_ui_activity_thinking_long');
    expect(liveActivityLabel(base, 50_000)).toBe('com_ui_activity_thinking_longer');
    expect(liveActivityLabel({ ...base, stage: 'waiting', state: 'waiting' }, 20_000)).toBe(
      'com_ui_activity_thinking_long',
    );
  });

  it('says the request is being prepared until the server has accepted it', () => {
    const waiting = { ...base, stage: 'waiting', state: 'waiting' } as const;
    expect(liveActivityLabel(waiting, 1_000, false)).toBe('com_ui_response_preparing');
    expect(liveActivityLabel(waiting, 1_000, true)).toBe('com_ui_activity_waiting');
    expect(liveActivityLabel(waiting, 20_000, false)).toBe('com_ui_activity_thinking_long');
    expect(liveActivityLabel(base, 1_000, false)).toBe('com_ui_activity_thinking');
  });

  it('keeps concrete stages and finished states unchanged', () => {
    expect(liveActivityLabel({ ...base, stage: 'writing' }, 60_000)).toBe(
      'com_ui_activity_writing',
    );
    expect(liveActivityLabel({ ...base, stage: 'tool', tool: 'web_search' }, 60_000)).toBe(
      'com_ui_activity_tool',
    );
    expect(liveActivityLabel({ ...base, state: 'done' }, 60_000)).toBe('com_ui_activity_done');
  });
});

describe('useHeld', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds a label for the minimum time before showing the next one', () => {
    const { result, rerender } = renderHook(({ value }) => useHeld(value, 650), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    expect(result.current).toBe('a');
    act(() => {
      jest.advanceTimersByTime(650);
    });
    expect(result.current).toBe('b');
  });

  it('shows urgent values immediately', () => {
    const { result, rerender } = renderHook(({ value, urgent }) => useHeld(value, 650, urgent), {
      initialProps: { value: 'a', urgent: false },
    });
    rerender({ value: 'done', urgent: true });
    expect(result.current).toBe('done');
  });
});
