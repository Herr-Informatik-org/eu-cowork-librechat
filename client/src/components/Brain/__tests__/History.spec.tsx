import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import { useBrainHistory } from '~/data-provider/Brain';
import History from '../History';

let mockUserId: string | undefined = 'user-one';
jest.mock('librechat-data-provider', () => {
  const actual: typeof import('librechat-data-provider') =
    jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('~/data-provider/Auth', () => ({
  useGetUserQuery: () => ({ data: mockUserId ? { id: mockUserId } : undefined }),
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default:
    () =>
    (key: string, values: Record<string, string | number> = {}) => {
      const translations = jest.requireActual<Record<string, string>>(
        '~/locales/en/translation.json',
      );
      return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(values[name] ?? ''),
      );
    },
}));

const status = (changes: Partial<BrainHistoryStatus> = {}): BrainHistoryStatus => ({
  status: 'idle',
  total: 12,
  processed: 0,
  saved: 0,
  skipped: 0,
  available: true,
  modelLabel: 'Configured test model',
  ...changes,
});
const clients: QueryClient[] = [];

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  clients.push(client);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}

beforeEach(() => {
  mockUserId = 'user-one';
  jest.spyOn(dataService, 'getBrainHistory').mockResolvedValue(status());
  jest.spyOn(dataService, 'startBrainHistory').mockResolvedValue(status({ status: 'running' }));
  jest.spyOn(dataService, 'pauseBrainHistory').mockResolvedValue(status({ status: 'paused' }));
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
});

test('explains personal scope, model and cost before an explicit start; opening never starts work', async () => {
  const context = setup();
  render(<History enabled />, context);
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('brain-history-start')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('brain-history-open'));
  expect(await screen.findByText(/your own saved messages/)).toBeInTheDocument();
  expect(screen.getByText(/Configured test model.*costs/)).toBeInTheDocument();
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
  await waitFor(() => expect(dataService.startBrainHistory).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
});

test('pauses and resumes the current run without discarding its progress', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'running', processed: 4, saved: 2 }));
  jest
    .mocked(dataService.pauseBrainHistory)
    .mockResolvedValue(status({ status: 'paused', processed: 4, saved: 2 }));
  render(<History enabled />, setup());
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
  expect(screen.getByText('4 of 12 messages reviewed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(dataService.startBrainHistory).toHaveBeenCalledTimes(1));
});

test('restores a paused server run after reopening without automatically resuming it', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'paused', processed: 7 }));
  const first = render(<History enabled />, setup());
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
  first.unmount();
  render(<History enabled />, setup());
  expect(await screen.findByText('7 of 12 messages reviewed')).toBeInTheDocument();
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
});

test('reports running progress and refreshes this user knowledge when the server completes', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValueOnce(status({ status: 'running', processed: 3 }))
    .mockResolvedValue(status({ status: 'completed', processed: 12, saved: 4, skipped: 2 }));
  const context = setup();
  context.client.setQueryData([QueryKeys.brain, 'user-one', 'graph', {}], { nodes: [] });
  context.client.setQueryData([QueryKeys.brain, 'user-two', 'graph', {}], { nodes: [] });
  render(<History enabled />, context);
  expect(await screen.findByText('3 of 12 messages reviewed')).toBeInTheDocument();
  expect(
    await screen.findByText('4 memories saved · 2 messages skipped', {}, { timeout: 4000 }),
  ).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '12');
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-one', 'graph', {}])?.isInvalidated,
  ).toBe(true);
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-two', 'graph', {}])?.isInvalidated,
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Check new chats' })).toBeInTheDocument();
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
});

test('shows the availability reason and prevents starting when Brain is opted out or has no model', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ available: false, reason: 'Enable your personal Brain first.' }));
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  expect(await screen.findByText('Enable your personal Brain first.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start now' })).toBeDisabled();
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
});

test('offers a retry for an unavailable status without pretending there is an empty run', async () => {
  jest.mocked(dataService.getBrainHistory).mockRejectedValue(new Error('Network down'));
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The current status could not be loaded',
  );
  expect(screen.queryByTestId('brain-history-start')).not.toBeInTheDocument();
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(status());
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByRole('button', { name: 'Start now' })).toBeEnabled();
});

test('refetches uncertain mutation results and keeps protocol errors out of the UI', async () => {
  jest.mocked(dataService.startBrainHistory).mockRejectedValue(new Error('internal stack trace'));
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  fireEvent.click(await screen.findByRole('button', { name: 'Start now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The action could not be confirmed');
  expect(screen.queryByText('internal stack trace')).not.toBeInTheDocument();
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(2));
});

test('does not fetch or expose the action without read and create eligibility', () => {
  render(<History enabled={false} />, setup());
  expect(screen.queryByTestId('brain-history-open')).not.toBeInTheDocument();
  expect(dataService.getBrainHistory).not.toHaveBeenCalled();
});

test('isolates status caches by authenticated user and does not fetch when signed out', async () => {
  mockUserId = undefined;
  const context = setup();
  const view = renderHook(() => useBrainHistory(true), context);
  expect(dataService.getBrainHistory).not.toHaveBeenCalled();
  mockUserId = 'user-one';
  view.rerender();
  await waitFor(() => expect(view.result.current.history.data?.total).toBe(12));
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(status({ total: 2 }));
  mockUserId = 'user-two';
  view.rerender();
  expect(view.result.current.history.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.history.data?.total).toBe(2));
  expect(
    context.client.getQueryData<BrainHistoryStatus>([QueryKeys.brain, 'user-one', 'history'])
      ?.total,
  ).toBe(12);
  expect(
    context.client.getQueryData<BrainHistoryStatus>([QueryKeys.brain, 'user-two', 'history'])
      ?.total,
  ).toBe(2);
});

test('aborts a status read when the view unmounts', async () => {
  jest.mocked(dataService.getBrainHistory).mockReturnValue(new Promise(() => {}));
  const view = renderHook(() => useBrainHistory(true), setup());
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(1));
  const signal = jest.mocked(dataService.getBrainHistory).mock.calls[0][0];
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

test('cancels an older status request before pausing so it cannot overwrite the paused response', async () => {
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(status({ status: 'running' }));
  const context = setup();
  const view = renderHook(() => useBrainHistory(true), context);
  await waitFor(() => expect(view.result.current.history.data?.status).toBe('running'));
  let resolvePending!: (value: BrainHistoryStatus) => void;
  jest.mocked(dataService.getBrainHistory).mockReturnValue(
    new Promise((resolve) => {
      resolvePending = resolve;
    }),
  );
  void view.result.current.history.refetch();
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(2));
  const signal = jest.mocked(dataService.getBrainHistory).mock.calls[1][0];
  await act(async () => {
    await view.result.current.pause.mutateAsync();
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolvePending(status({ status: 'running' }));
  });
  expect(
    context.client.getQueryData<BrainHistoryStatus>([QueryKeys.brain, 'user-one', 'history'])
      ?.status,
  ).toBe('paused');
  await waitFor(() => expect(view.result.current.history.data?.status).toBe('paused'));
});

test('also cancels a status read started while the pause request is in flight', async () => {
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(status({ status: 'running' }));
  const context = setup();
  const view = renderHook(() => useBrainHistory(true), context);
  await waitFor(() => expect(view.result.current.history.data?.status).toBe('running'));
  let finishPause!: (value: BrainHistoryStatus) => void;
  jest.mocked(dataService.pauseBrainHistory).mockReturnValue(
    new Promise((resolve) => {
      finishPause = resolve;
    }),
  );
  act(() => view.result.current.pause.mutate());
  await waitFor(() => expect(dataService.pauseBrainHistory).toHaveBeenCalledTimes(1));
  let finishRead!: (value: BrainHistoryStatus) => void;
  jest.mocked(dataService.getBrainHistory).mockReturnValue(
    new Promise((resolve) => {
      finishRead = resolve;
    }),
  );
  void view.result.current.history.refetch();
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(2));
  const signal = jest.mocked(dataService.getBrainHistory).mock.calls[1][0];
  await act(async () => {
    finishPause(status({ status: 'paused' }));
  });
  await waitFor(() => expect(view.result.current.history.data?.status).toBe('paused'));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finishRead(status({ status: 'running' }));
  });
  expect(
    context.client.getQueryData<BrainHistoryStatus>([QueryKeys.brain, 'user-one', 'history'])
      ?.status,
  ).toBe('paused');
});
