/**
 * White-box integration test for `useTitleGeneration`'s effect logic.
 *
 * Complements the helper unit tests in `queries.test.ts` by driving the REAL
 * hook (real React state/effects) with a controllable react-query surface, so
 * the stateful decisions — immediate-vs-final eligibility, success application,
 * defer-while-active, and the post-completion `resetQueries` remount — are
 * deterministically locked down without timer/async flakiness.
 *
 * `~/utils` re-exports from `@librechat/client` (framer-motion peer, absent in
 * jsdom); mocked to the two symbols the hook uses. react-query is mocked so we
 * control `activeJobIds`, the per-conversation query results, and spy the
 * QueryClient — the hook's own React effects still run for real.
 */
let mockActiveJobIds: string[] = [];
let mockTiming: 'immediate' | 'final' = 'immediate';
let mockQueriesResults: Array<{
  isSuccess?: boolean;
  isError?: boolean;
  data?: { title: string };
  error?: unknown;
}> = [];
let mockCapturedQueries: Array<{ queryKey: unknown[] }> = [];

const mockSetQueryData = jest.fn();
const mockRemoveQueries = jest.fn();
const mockResetQueries = jest.fn();
const mockUpdateConvoInAllQueries = jest.fn();
type CacheEvent = {
  type: string;
  action: { type: string; manual?: boolean };
  query: { queryKey: unknown[]; state: { data: unknown } };
};
let mockCacheListener: ((event: CacheEvent) => void) | null = null;
const mockSubscribe = jest.fn((listener: (event: CacheEvent) => void) => {
  mockCacheListener = listener;
  return () => {
    mockCacheListener = null;
  };
});

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: { activeJobIds: mockActiveJobIds } })),
  useQueries: jest.fn(({ queries }: { queries: Array<{ queryKey: unknown[] }> }) => {
    mockCapturedQueries = queries;
    return mockQueriesResults;
  }),
  useQueryClient: jest.fn(() => mockQueryClient),
}));

const mockQueryClient = {
  setQueryData: mockSetQueryData,
  removeQueries: mockRemoveQueries,
  resetQueries: mockResetQueries,
  getQueryCache: () => ({ subscribe: mockSubscribe }),
};

jest.mock('../../Endpoints', () => ({
  useGetStartupConfig: () => ({ data: { titleGenerationTiming: mockTiming } }),
}));

jest.mock('~/utils', () => ({
  isNotFoundError: (error: unknown): boolean => {
    if (error != null && typeof error === 'object') {
      return (error as { response?: { status?: number } }).response?.status === 404;
    }
    return false;
  },
  updateConvoInAllQueries: (...args: unknown[]) => mockUpdateConvoInAllQueries(...args),
}));

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  QueryKeys: {
    conversation: 'conversation',
    activeJobs: 'activeJobs',
    allConversations: 'allConversations',
  },
  request: { get: jest.fn() },
  dataService: { genTitle: jest.fn(), getActiveJobs: jest.fn() },
}));

import { renderHook, act } from '@testing-library/react';
import {
  useTitleGeneration,
  genTitleQueryKey,
  queueTitleGeneration,
  markTitleGenerationProcessed,
} from '../queries';

const notFound = { response: { status: 404 } };

/** queryKeys passed to the latest `useQueries` call (i.e. the ready-to-fetch set). */
const eligibleKeys = () => mockCapturedQueries.map((q) => JSON.stringify(q.queryKey));
const isEligible = (id: string) => eligibleKeys().includes(JSON.stringify(genTitleQueryKey(id)));

beforeEach(() => {
  mockActiveJobIds = [];
  mockTiming = 'immediate';
  mockQueriesResults = [];
  mockCapturedQueries = [];
  jest.clearAllMocks();
});

describe('useTitleGeneration — eligibility', () => {
  it('immediate mode: fetches a queued conversation while its stream is still active', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-imm'];

    renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-imm'));

    expect(isEligible('conv-imm')).toBe(true);
  });

  it('final mode: gates a queued conversation until its stream completes', () => {
    mockTiming = 'final';
    mockActiveJobIds = ['conv-fin'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-fin'));
    expect(isEligible('conv-fin')).toBe(false);

    // Stream completes — the conversation leaves the active set.
    mockActiveJobIds = [];
    rerender();
    expect(isEligible('conv-fin')).toBe(true);
  });

  it('stops polling when a title is completed by an SSE event', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-sse-title'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-sse-title'));
    expect(isEligible('conv-sse-title')).toBe(true);

    act(() => markTitleGenerationProcessed('conv-sse-title'));
    rerender();

    expect(isEligible('conv-sse-title')).toBe(false);
  });
});

describe('useTitleGeneration — result handling', () => {
  it('applies the fetched title to the conversation caches on success', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-ok'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-ok'));

    mockQueriesResults = [{ isSuccess: true, isError: false, data: { title: 'Quantum Chat' } }];
    rerender();

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['conversation', 'conv-ok'],
      expect.any(Function),
    );
    expect(mockUpdateConvoInAllQueries).toHaveBeenCalled();

    const call = mockSetQueryData.mock.calls.find(
      ([key]) => JSON.stringify(key) === JSON.stringify(['conversation', 'conv-ok']),
    );
    const updater = call?.[1] as (c?: { title?: string }) => { title?: string };
    expect(updater({ title: 'New Chat' })).toEqual(
      expect.objectContaining({ title: 'Quantum Chat' }),
    );
  });

  it('a 404 while the stream is active defers (removeQueries), not giving up', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = ['conv-active404'];

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-active404'));

    mockQueriesResults = [{ isError: true, isSuccess: false, error: notFound }];
    rerender();

    expect(mockRemoveQueries).toHaveBeenCalledWith(genTitleQueryKey('conv-active404'));
    expect(mockResetQueries).not.toHaveBeenCalled();
  });

  it('a 404 after the stream completes forces a fresh fetch via resetQueries', () => {
    mockTiming = 'immediate';
    mockActiveJobIds = []; // stream already complete

    const { rerender } = renderHook(() => useTitleGeneration(true));
    act(() => queueTitleGeneration('conv-done404'));

    mockQueriesResults = [{ isError: true, isSuccess: false, error: notFound }];
    rerender();

    expect(mockResetQueries).toHaveBeenCalledWith(genTitleQueryKey('conv-done404'));
  });
});

describe('useTitleGeneration — titles survive a refetch before the server saved them', () => {
  const listEvent = (conversationId: string, title: string, manual = false): CacheEvent => ({
    type: 'updated',
    action: { type: 'success', manual },
    query: {
      queryKey: ['allConversations', {}],
      state: { data: { pages: [{ conversations: [{ conversationId, title }] }] } },
    },
  });
  const flush = () => act(async () => Promise.resolve());
  const appliedTitle = (conversationId: string) => {
    const call = mockUpdateConvoInAllQueries.mock.calls.find(([, id]) => id === conversationId);
    const updater = call?.[2] as ((c: { title?: string }) => { title?: string }) | undefined;
    return updater?.({ title: 'New Chat' }).title;
  };

  it('restores a title that a list refetch replaced with the placeholder', async () => {
    renderHook(() => useTitleGeneration(true));
    act(() => markTitleGenerationProcessed('conv-refetch', 'Budget review'));

    act(() => mockCacheListener?.(listEvent('conv-refetch', 'New Chat')));
    await flush();

    expect(appliedTitle('conv-refetch')).toBe('Budget review');
  });

  it('forgets the title once the server returns a real one', async () => {
    renderHook(() => useTitleGeneration(true));
    act(() => markTitleGenerationProcessed('conv-saved', 'Budget review'));

    act(() => mockCacheListener?.(listEvent('conv-saved', 'Budget review')));
    await flush();
    act(() => mockCacheListener?.(listEvent('conv-saved', 'New Chat', true)));
    await flush();

    expect(mockUpdateConvoInAllQueries).not.toHaveBeenCalled();
  });

  it('keeps the title when only a local write repeats it', async () => {
    renderHook(() => useTitleGeneration(true));
    act(() => markTitleGenerationProcessed('conv-local', 'Offer draft'));

    act(() => mockCacheListener?.(listEvent('conv-local', 'Offer draft', true)));
    await flush();
    act(() => mockCacheListener?.(listEvent('conv-local', 'New Chat', true)));
    await flush();

    expect(appliedTitle('conv-local')).toBe('Offer draft');
  });

  it('does not watch the cache while signed out', () => {
    renderHook(() => useTitleGeneration(false));
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});
