import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MailWorkspaceMoveJob } from 'librechat-data-provider';
import { useMailActions, useMailMoveJobs } from '../queries';

let mockOwner: { id: string } | null = { id: 'first-owner' };
const mockReadJobs = jest.fn();
const mockEnqueueMove = jest.fn();
jest.mock('recoil', () => ({ useRecoilValue: () => mockOwner }));
jest.mock('~/store', () => ({ __esModule: true, default: { user: {} } }));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    getMailWorkspaceMoveJobs: (...args: object[]) => mockReadJobs(...args),
    enqueueMailWorkspaceMove: (...args: object[]) => mockEnqueueMove(...args),
  },
}));
const makeJob = (id: string): MailWorkspaceMoveJob => ({
  id,
  status: 'completed',
  folderName: `${id}-private-folder`,
  total: 1,
  completed: 1,
  failed: 0,
  createdAt: '2026-10-27T10:00:00Z',
  updatedAt: '2026-10-27T10:01:00Z',
  items: [{ id: `${id}-mail`, subject: `${id}-private-subject`, status: 'completed' }],
});

beforeEach(() => {
  mockOwner = { id: 'first-owner' };
  mockReadJobs.mockReset();
  mockEnqueueMove.mockReset();
});
it('does not expose previous-owner jobs while the next owner request is pending', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let completeSecond: (value: { jobs: MailWorkspaceMoveJob[] }) => void = () => undefined;
  mockReadJobs.mockResolvedValueOnce({ jobs: [makeJob('first')] });
  mockReadJobs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSecond = resolve;
      }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useMailMoveJobs(true), { wrapper });
  await waitFor(() => expect(view.result.current.data?.jobs[0].id).toBe('first'));
  mockOwner = { id: 'second-owner' };
  view.rerender();
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(mockReadJobs).toHaveBeenCalledTimes(2));
  act(() => completeSecond({ jobs: [makeJob('second')] }));
  await waitFor(() => expect(view.result.current.data?.jobs[0].id).toBe('second'));
  mockOwner = null;
  view.rerender();
  expect(view.result.current.data).toBeUndefined();
  expect(mockReadJobs).toHaveBeenCalledTimes(2);
  view.unmount();
  client.clear();
});
it('does not request job metadata on an unavailable or disconnected page', () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useMailMoveJobs(false), { wrapper });
  expect(mockReadJobs).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
});

it('releases accepted requests while the follow-up status fetch is still pending', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const job = {
    ...makeJob('accepted'),
    status: 'queued' as const,
    completed: 0,
    items: [{ id: 'mail', subject: 'Mail', status: 'queued' as const }],
  };
  mockReadJobs.mockResolvedValueOnce({ jobs: [] });
  mockReadJobs.mockImplementationOnce(() => new Promise(() => undefined));
  mockEnqueueMove.mockResolvedValue({ job });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => ({ jobs: useMailMoveJobs(true), actions: useMailActions() }), {
    wrapper,
  });
  await waitFor(() => expect(view.result.current.jobs.data).toEqual({ jobs: [] }));
  await act(async () => {
    await view.result.current.actions.enqueueMove.mutateAsync({
      requestId: '00000000-0000-4000-8000-000000000001',
      folderId: 'done',
      items: [{ id: 'mail', revision: 'snapshot' }],
    });
  });
  await waitFor(() => expect(view.result.current.actions.enqueueMove.isLoading).toBe(false));
  expect(view.result.current.jobs.data?.jobs[0].id).toBe('accepted');
  expect(view.result.current.jobs.isFetching).toBe(true);
  view.unmount();
  client.clear();
});
