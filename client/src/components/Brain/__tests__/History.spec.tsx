import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { BrainHistoryStatus } from 'librechat-data-provider';
import { useBrainHistory, useBrainRebuild } from '~/data-provider/Brain';
import History from '../History';
import { rebuildFixture } from './fixtures';

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
  schemaVersion: 2,
  unit: 'chats',
  rebuildId: 'rebuild-one',
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
  jest
    .spyOn(dataService, 'getBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: false });
  jest.spyOn(dataService, 'startBrainRebuild').mockImplementation(async () => {
    jest.mocked(dataService.getBrainHistory).mockResolvedValue(status({ status: 'running' }));
    const draft = rebuildFixture();
    if (draft.rebuild) draft.rebuild.autoActivate = true;
    jest.mocked(dataService.getBrainRebuild).mockResolvedValue(draft);
    return draft;
  });
  jest
    .spyOn(dataService, 'activateBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: true });
  jest
    .spyOn(dataService, 'discardBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: false });
  jest
    .spyOn(dataService, 'rollbackBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: false });
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
  expect(await screen.findByText(/deine gespeicherten Gespräche/)).toBeInTheDocument();
  expect(screen.getByText(/Configured test model.*costs/)).toBeInTheDocument();
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
  expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start now' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
  const confirmation = await screen.findByRole('dialog');
  expect(confirmation).toHaveTextContent('übernimmt das fertige Ergebnis automatisch');
  expect(confirmation).toHaveTextContent('bisheriges Brain bleibt bis zum Abschluss');
  expect(confirmation).toHaveTextContent('geschützte Änderungen und bewusste Löschungen');
  expect(confirmation).toHaveTextContent('Configured test model');
  expect(confirmation).toHaveTextContent('Modellkosten');
  expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Neuaufbau starten' }));
  await waitFor(() => expect(dataService.startBrainRebuild).toHaveBeenCalledTimes(1));
  expect(dataService.startBrainRebuild).toHaveBeenCalledWith({ autoActivate: true });
  expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
});

test('pauses and resumes the current run without discarding its progress', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture());
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'running', processed: 4, saved: 2 }));
  jest
    .mocked(dataService.pauseBrainHistory)
    .mockResolvedValue(status({ status: 'paused', processed: 4, saved: 2 }));
  render(<History enabled />, setup());
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
  expect(screen.getByText('4 of 12 chats reviewed')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(dataService.startBrainHistory).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
});

test('restores a paused server run after reopening without automatically resuming it', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture());
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'paused', processed: 7 }));
  const first = render(<History enabled />, setup());
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
  first.unmount();
  render(<History enabled />, setup());
  expect(await screen.findByText('7 of 12 chats reviewed')).toBeInTheDocument();
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
  expect(await screen.findByText('3 of 12 chats reviewed')).toBeInTheDocument();
  expect(
    await screen.findByText(
      '4 memories prepared · 2 chats without new memories',
      {},
      { timeout: 4000 },
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '12');
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-one', 'graph', {}])?.isInvalidated,
  ).toBe(true);
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-two', 'graph', {}])?.isInvalidated,
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Rebuild from chats' })).toBeInTheDocument();
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
  jest.mocked(dataService.startBrainRebuild).mockRejectedValue(new Error('internal stack trace'));
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start now' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Neuaufbau starten' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The change could not be confirmed');
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

test('legacy message jobs offer a separate rebuild and cannot be resumed as contextual jobs', async () => {
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(
    status({
      schemaVersion: undefined,
      unit: 'messages',
      status: 'paused',
      processed: 22,
      total: 336,
    }),
  );
  render(<History enabled />, setup());
  expect(
    await screen.findByText(/earlier import reviewed individual messages/),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  expect(screen.queryByText('22 of 336 chats reviewed')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Rebuild from chats' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Rebuild from chats' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Neuaufbau starten' }));
  await waitFor(() => expect(dataService.startBrainRebuild).toHaveBeenCalledTimes(1));
  expect(dataService.startBrainHistory).not.toHaveBeenCalled();
});

test.each(['paused', 'running'] as const)(
  'recovers a draft with an unrelated %s history job through the idempotent rebuild endpoint',
  async (jobStatus) => {
    jest
      .mocked(dataService.getBrainHistory)
      .mockResolvedValue(status({ status: jobStatus, rebuildId: 'older-rebuild' }));
    jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture());
    render(<History enabled />, setup());
    await screen.findByRole('button', { name: 'Discard new version' });
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(dataService.startBrainRebuild).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dataService.startBrainHistory).not.toHaveBeenCalled();
    expect(dataService.pauseBrainHistory).not.toHaveBeenCalled();
  },
);

test('a ready preview keeps old knowledge active until the user activates the exact reviewed revision', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'completed', processedSections: 19 }));
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture('ready'));
  render(<History enabled />, setup());
  expect(await screen.findByRole('button', { name: 'Use new version' })).toBeEnabled();
  expect(screen.getByText(/current knowledge stays active/)).toBeInTheDocument();
  expect(screen.getByText('19 conversation sections reviewed')).toBeInTheDocument();
  expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('View changes and sources'));
  expect(screen.getByText('Projekt Abendrot')).toBeInTheDocument();
  expect(screen.getByText('Old fragment')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use new version' }));
  await waitFor(() =>
    expect(dataService.activateBrainRebuild).toHaveBeenCalledWith('rebuild-one', 7),
  );
  expect(
    await screen.findByRole('button', { name: 'Return to previous version' }),
  ).toBeInTheDocument();
});

test.each(['paused', 'failed'] as const)(
  'an automatic ready %s run resumes activation without another confirmation',
  async (runStatus) => {
    const rebuild = rebuildFixture('ready');
    if (rebuild.rebuild) rebuild.rebuild.autoActivate = true;
    jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuild);
    jest
      .mocked(dataService.getBrainHistory)
      .mockResolvedValue(status({ status: runStatus, autoActivate: true }));
    render(<History enabled />, setup());
    expect(await screen.findByText(/Setze den Lauf fort/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use new version' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(dataService.startBrainHistory).toHaveBeenCalledTimes(1));
    expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
    expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);

test('an automatic finalization cannot be paused or discarded and needs no manual activation', async () => {
  const rebuild = rebuildFixture();
  if (rebuild.rebuild) rebuild.rebuild.autoActivate = true;
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuild);
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'running', autoActivate: true, finalizing: true }));
  render(<History enabled />, setup());
  expect(await screen.findByText('Wird automatisch übernommen …')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Discard new version' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Use new version' })).not.toBeInTheDocument();
  expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
});

test('automatic completion reports the new active Brain without an apply action', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'completed', autoActivate: true }));
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  expect(await screen.findByText('Your new Brain version is now active.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use new version' })).not.toBeInTheDocument();
  expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
});

test('recovers a lost completion acknowledgement without creating another Brain version', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'failed', autoActivate: true }));
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue({
    rebuild: null,
    activeGenerationId: 'rebuild-one',
    rollbackAvailable: true,
  });
  render(<History enabled />, setup());
  fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(dataService.startBrainHistory).toHaveBeenCalledTimes(1));
  expect(dataService.startBrainRebuild).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('does not report the rebuilt Brain as active after returning to another version', async () => {
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue(status({ status: 'completed', autoActivate: true }));
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue({
    rebuild: null,
    activeGenerationId: 'previous-version',
    rollbackAvailable: false,
  });
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  await screen.findByRole('button', { name: 'Rebuild from chats' });
  expect(screen.queryByText('Your new Brain version is now active.')).not.toBeInTheDocument();
});

test('a conflicting activation reloads the preview and requires a fresh explicit activation', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture('ready'));
  jest.mocked(dataService.activateBrainRebuild).mockImplementation(async () => {
    const updated = rebuildFixture('ready');
    if (updated.rebuild) updated.rebuild.revision = 8;
    jest.mocked(dataService.getBrainRebuild).mockResolvedValue(updated);
    throw new Error('private conflict detail');
  });
  const context = setup();
  render(<History enabled />, context);
  fireEvent.click(await screen.findByRole('button', { name: 'Use new version' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The change could not be confirmed');
  await waitFor(() => expect(dataService.getBrainRebuild).toHaveBeenCalledTimes(2));
  expect(dataService.activateBrainRebuild).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('private conflict detail')).not.toBeInTheDocument();
  jest
    .mocked(dataService.activateBrainRebuild)
    .mockResolvedValue({ rebuild: null, rollbackAvailable: true });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Use new version' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use new version' }));
  await waitFor(() =>
    expect(dataService.activateBrainRebuild).toHaveBeenLastCalledWith('rebuild-one', 8),
  );
});

test('discarding a draft uses its identifier without deleting active memories', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture());
  const deletion = jest.spyOn(dataService, 'deleteBrainNode');
  render(<History enabled />, setup());
  fireEvent.click(await screen.findByRole('button', { name: 'Discard new version' }));
  await waitFor(() => expect(dataService.discardBrainRebuild).toHaveBeenCalledWith('rebuild-one'));
  expect(deletion).not.toHaveBeenCalled();
  expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
});

test('rollback requires one explicit confirmation and is not automatic when the panel opens', async () => {
  jest
    .mocked(dataService.getBrainRebuild)
    .mockResolvedValue({ rebuild: null, rollbackAvailable: true });
  render(<History enabled />, setup());
  fireEvent.click(screen.getByTestId('brain-history-open'));
  fireEvent.click(await screen.findByRole('button', { name: 'Return to previous version' }));
  expect(
    screen.getByText(/Recent personal changes and deliberate deletions remain protected/),
  ).toBeInTheDocument();
  expect(dataService.rollbackBrainRebuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Return to previous version' }));
  await waitFor(() => expect(dataService.rollbackBrainRebuild).toHaveBeenCalledTimes(1));
});

test('a late activation response only invalidates the user who initiated the rebuild', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture('ready'));
  const context = setup();
  context.client.setQueryData([QueryKeys.brain, 'user-one', 'graph', {}], { nodes: [] });
  context.client.setQueryData([QueryKeys.brain, 'user-two', 'graph', {}], { nodes: [] });
  const view = renderHook(() => useBrainRebuild(true), context);
  await waitFor(() => expect(view.result.current.rebuild.data?.rebuild?.status).toBe('ready'));
  let finishActivation!: (value: { rebuild: null; rollbackAvailable: boolean }) => void;
  jest.mocked(dataService.activateBrainRebuild).mockReturnValue(
    new Promise((resolve) => {
      finishActivation = resolve;
    }),
  );
  act(() => view.result.current.activate.mutate({ id: 'rebuild-one', revision: 7 }));
  await waitFor(() => expect(dataService.activateBrainRebuild).toHaveBeenCalledTimes(1));
  mockUserId = 'user-two';
  jest
    .mocked(dataService.getBrainRebuild)
    .mockResolvedValue({ rebuild: null, rollbackAvailable: false });
  view.rerender();
  await waitFor(() => expect(view.result.current.rebuild.data?.rollbackAvailable).toBe(false));
  await act(async () => finishActivation({ rebuild: null, rollbackAvailable: true }));
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-one', 'graph', {}])?.isInvalidated,
  ).toBe(true);
  expect(
    context.client.getQueryState([QueryKeys.brain, 'user-two', 'graph', {}])?.isInvalidated,
  ).toBe(false);
  expect(view.result.current.rebuild.data?.rollbackAvailable).toBe(false);
});
