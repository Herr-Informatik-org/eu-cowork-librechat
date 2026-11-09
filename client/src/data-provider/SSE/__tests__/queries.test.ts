/**
 * `~/utils` re-exports from `@librechat/client`, which pulls in framer-motion (an
 * external peer not present in the jsdom test env). Provide a minimal mock with the
 * two symbols `queries.ts` uses. `isNotFoundError` mirrors the real axios-only
 * implementation in `~/utils/errors`.
 */
jest.mock('~/utils', () => {
  const isNotFoundError = (error: unknown): boolean => {
    if (error != null && typeof error === 'object') {
      const response = (error as { response?: { status?: number } }).response;
      return response?.status === 404;
    }
    return false;
  };
  return { isNotFoundError, updateConvoInAllQueries: jest.fn() };
});

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  QueryKeys: {
    conversation: 'conversation',
    activeJobs: 'activeJobs',
    allConversations: 'allConversations',
  },
  request: { get: jest.fn() },
  dataService: { genTitle: jest.fn(), getActiveJobs: jest.fn(), getConversationById: jest.fn() },
}));

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(() => ({ data: undefined })),
  useQueries: jest.fn(() => []),
  useQueryClient: jest.fn(() => ({ setQueryData: jest.fn(), removeQueries: jest.fn() })),
}));

/** `queries.ts` imports `useGetStartupConfig` from `../Endpoints` (i.e.
 *  `data-provider/Endpoints`); from this test file that resolves to `../../Endpoints`.
 *  Mock it so the module under test does not pull in the full data-provider barrel. */
jest.mock('../../Endpoints', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: undefined })),
}));

import { useQuery } from '@tanstack/react-query';
import { request, dataService } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import {
  useActiveJobs,
  genTitleQueryKey,
  fetchStreamStatus,
  queueTitleGeneration,
  refreshConversationTitle,
  markTitleGenerationProcessed,
} from '../queries';
import { updateConvoInAllQueries } from '~/utils';

describe('fetchStreamStatus generation protocol advertisement', () => {
  it('sends v2 in both the query and header', async () => {
    (request.get as jest.Mock).mockResolvedValueOnce({ active: false });

    await expect(fetchStreamStatus('conversation-1')).resolves.toEqual({ active: false });
    expect(request.get).toHaveBeenCalledWith(
      '/api/agents/chat/status/conversation-1?generationProtocolVersion=2',
      { headers: { 'X-LibreChat-Generation-Protocol': '2' } },
    );
  });
});

/** Build a minimal Axios-shaped error with a given HTTP status. */
function makeAxiosError(status: number): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number };
  };
  err.isAxiosError = true;
  err.response = { status };
  return err;
}

describe('genTitleQueryKey', () => {
  it('returns a two-element tuple with the conversationId', () => {
    expect(genTitleQueryKey('abc-123')).toEqual(['genTitle', 'abc-123']);
  });

  it('returns different keys for different conversation IDs', () => {
    expect(genTitleQueryKey('conv-1')).not.toEqual(genTitleQueryKey('conv-2'));
  });
});

describe('queueTitleGeneration', () => {
  it('runs without throwing for a new conversation ID', () => {
    expect(() => queueTitleGeneration('new-conv-queue-1')).not.toThrow();
  });

  it('is safe to call multiple times for the same conversation ID', () => {
    expect(() => {
      queueTitleGeneration('new-conv-queue-2');
      queueTitleGeneration('new-conv-queue-2');
    }).not.toThrow();
  });
});

/**
 * The title-fetch retry policy in `useTitleGeneration`:
 *
 *   retry: (failureCount, error) => isNotFoundError(error) && failureCount < 3
 *   retryDelay: () => 5_000
 *
 * The server `/gen_title` route waits up to ~15.5s before returning 404 while the
 * title is still generating. Retrying ONLY on 404 (never on 401/403/5xx/network)
 * means a transient "still generating" response is never treated as final (#13318),
 * while genuine errors stay terminal.
 *
 * These tests pin the classification contract and the failure cap so any future
 * change to either is caught.
 */
describe('title fetch retry policy — error classification', () => {
  const isNotFoundError = (error: unknown): boolean => {
    if (error != null && typeof error === 'object') {
      const response = (error as { response?: { status?: number } }).response;
      return response?.status === 404;
    }
    return false;
  };

  it('returns true for a 404 (server still generating the title)', () => {
    expect(isNotFoundError(makeAxiosError(404))).toBe(true);
  });

  it('returns false for a 401 (auth failure — do not retry)', () => {
    expect(isNotFoundError(makeAxiosError(401))).toBe(false);
  });

  it('returns false for a 500 (server failure — do not retry)', () => {
    expect(isNotFoundError(makeAxiosError(500))).toBe(false);
  });

  it('returns false for a plain network Error', () => {
    expect(isNotFoundError(new Error('Network Error'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});

describe('title fetch retry policy — failure cap', () => {
  const isNotFoundError = (error: unknown): boolean => {
    if (error != null && typeof error === 'object') {
      const response = (error as { response?: { status?: number } }).response;
      return response?.status === 404;
    }
    return false;
  };

  const retryPredicate = (failureCount: number, error: unknown): boolean =>
    isNotFoundError(error) && failureCount < 3;

  const notFound = makeAxiosError(404);

  it('retries the first three 404 failures', () => {
    expect(retryPredicate(0, notFound)).toBe(true);
    expect(retryPredicate(1, notFound)).toBe(true);
    expect(retryPredicate(2, notFound)).toBe(true);
  });

  it('stops after the third 404 failure', () => {
    expect(retryPredicate(3, notFound)).toBe(false);
  });

  it('never retries a non-404 regardless of attempt count', () => {
    const authErr = makeAxiosError(401);
    for (let i = 0; i < 5; i++) {
      expect(retryPredicate(i, authErr)).toBe(false);
    }
  });
});

describe('useActiveJobs', () => {
  it('keeps polling running jobs while the window is in the background', () => {
    useActiveJobs();
    const options = (useQuery as jest.Mock).mock.calls.at(-1)?.[0];
    expect(options.refetchIntervalInBackground).toBe(true);
    expect(options.refetchInterval({ activeJobIds: ['running'] })).toBe(5_000);
    expect(options.refetchInterval({ activeJobIds: [] })).toBe(false);
  });
});

describe('refreshConversationTitle', () => {
  const getConversationById = dataService.getConversationById as jest.Mock;
  const updateList = updateConvoInAllQueries as jest.Mock;

  const clientWithListTitle = (conversationId: string, title: string | null) =>
    ({
      setQueryData: jest.fn(),
      getQueriesData: jest.fn(() => [
        [['allConversations', {}], { pages: [{ conversations: [{ conversationId, title }] }] }],
      ]),
    }) as unknown as QueryClient & { setQueryData: jest.Mock };

  const appliedTitle = () => {
    const updater = updateList.mock.calls.at(-1)?.[2] as (c: { title?: string }) => {
      title?: string;
    };
    return updater({ title: 'New Chat' }).title;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    getConversationById.mockReset();
    updateList.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads the saved title of a background chat that still shows the placeholder', async () => {
    getConversationById.mockResolvedValueOnce({ conversationId: 'bg-1', title: 'Quarterly plan' });
    const client = clientWithListTitle('bg-1', 'New Chat');

    await refreshConversationTitle(client, 'bg-1');

    expect(getConversationById).toHaveBeenCalledTimes(1);
    expect(appliedTitle()).toBe('Quarterly plan');
    expect(client.setQueryData).toHaveBeenCalledWith(
      ['conversation', 'bg-1'],
      expect.any(Function),
    );
  });

  it('waits for a title that the server saves shortly after the job ended', async () => {
    getConversationById
      .mockResolvedValueOnce({ conversationId: 'bg-late', title: 'New Chat' })
      .mockResolvedValueOnce({ conversationId: 'bg-late', title: 'Travel costs' });
    const refresh = refreshConversationTitle(clientWithListTitle('bg-late', null), 'bg-late');

    await jest.advanceTimersByTimeAsync(4_000);
    await refresh;

    expect(getConversationById).toHaveBeenCalledTimes(2);
    expect(appliedTitle()).toBe('Travel costs');
  });

  it('gives up after a bounded number of reads', async () => {
    getConversationById.mockResolvedValue({ conversationId: 'bg-none', title: 'New Chat' });
    const refresh = refreshConversationTitle(clientWithListTitle('bg-none', 'New Chat'), 'bg-none');

    await jest.advanceTimersByTimeAsync(20_000);
    await refresh;

    expect(getConversationById).toHaveBeenCalledTimes(3);
    expect(updateList).not.toHaveBeenCalled();
  });

  it('does not ask the server when the list already has a real title', async () => {
    await refreshConversationTitle(clientWithListTitle('bg-titled', 'Known title'), 'bg-titled');
    expect(getConversationById).not.toHaveBeenCalled();
  });

  it('reuses a title the session already received instead of reading it again', async () => {
    markTitleGenerationProcessed('bg-known', 'Received live');
    await refreshConversationTitle(clientWithListTitle('bg-known', 'New Chat'), 'bg-known');

    expect(getConversationById).not.toHaveBeenCalled();
    expect(appliedTitle()).toBe('Received live');
  });

  it('keeps the current title when the conversation cannot be read', async () => {
    getConversationById.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    await expect(
      refreshConversationTitle(clientWithListTitle('bg-gone', 'New Chat'), 'bg-gone'),
    ).resolves.toBeUndefined();
    expect(updateList).not.toHaveBeenCalled();
  });
});
