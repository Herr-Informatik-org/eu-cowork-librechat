import React from 'react';
import { AxiosError } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import Workspace from '../Workspace';
import { graphFixture, memory, rebuildFixture } from './fixtures';

let mockCanWrite = true;
jest.mock('librechat-data-provider', () => {
  const actual: typeof import('librechat-data-provider') =
    jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockCanWrite,
}));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('~/data-provider/Auth', () => ({
  useGetUserQuery: () => ({ data: { id: 'user-one' } }),
}));
jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'chat-one' }) }));

function renderWorkspace() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Workspace onClose={jest.fn()} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  mockCanWrite = true;
  jest
    .spyOn(dataService, 'getBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: false });
  jest.spyOn(dataService, 'getBrainHistory').mockResolvedValue({
    status: 'idle',
    total: 0,
    processed: 0,
    saved: 0,
    skipped: 0,
    available: true,
  });
  jest.spyOn(dataService, 'getBrainGraph').mockResolvedValue(graphFixture);
  jest
    .spyOn(dataService, 'getBrainNode')
    .mockResolvedValue({ node: memory(), edges: graphFixture.edges });
  jest.spyOn(dataService, 'getBrainRecalls').mockResolvedValue({ recalls: [] });
});

test('shows an honest empty state and no preloaded demo memories', async () => {
  jest
    .mocked(dataService.getBrainGraph)
    .mockResolvedValue({ nodes: [], edges: [], total: 0, nextCursor: null });
  renderWorkspace();
  expect(await screen.findByText('com_ui_brain_empty_title')).toBeInTheDocument();
  expect(screen.queryByText('Projekt Abendrot')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /com_ui_brain_first_memory/ })).toBeInTheDocument();
});

test('loading does not pretend that the Brain is empty', () => {
  jest.mocked(dataService.getBrainGraph).mockReturnValue(new Promise(() => {}));
  const view = renderWorkspace();
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_brain_loading');
  expect(screen.queryByText('com_ui_brain_empty_title')).not.toBeInTheDocument();
  view.unmount();
});

test('an unavailable service shows a recoverable error without invented memories', async () => {
  jest.mocked(dataService.getBrainGraph).mockRejectedValue(new Error('Service unavailable'));
  renderWorkspace();
  expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent(
    'com_ui_brain_unavailable',
  );
  expect(screen.getByRole('button', { name: 'com_ui_brain_retry' })).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'com_ui_brain_memories' })).not.toBeInTheDocument();
});

test('loads the selected memory with its source and prevents accidental immediate forgetting', async () => {
  const remove = jest.spyOn(dataService, 'deleteBrainNode').mockResolvedValue({ deleted: true });
  renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  expect(await screen.findByRole('link', { name: /Pilot planen/ })).toHaveAttribute(
    'href',
    '/c/chat-one',
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_brain_forget' }));
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText('com_ui_brain_forget_confirm')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_brain_forget' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('node-one'));
});

test('shows the claim scope and distinguishes assistant context from a user evidence quote', async () => {
  const node = memory({
    claimState: 'planned',
    basis: 'direct',
    validFrom: '2026-09-14T00:00:00Z',
    validUntil: '2026-10-01T00:00:00Z',
    sources: [
      { ...memory().sources[0], role: 'user' },
      {
        ...memory().sources[0],
        id: 'context-source',
        messageId: 'assistant-one',
        role: 'assistant',
        dependency: true,
        excerpt: 'Ist dies nur für den Pilot vorgesehen?',
      },
      {
        ...memory().sources[0],
        id: 'context-only-source',
        messageId: 'context-only-message',
        dependency: true,
        excerpt: undefined,
      },
    ],
  });
  jest.mocked(dataService.getBrainNode).mockResolvedValue({ node, edges: [] });
  renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  const details = await screen.findByRole('complementary', { name: 'com_ui_brain_details' });
  expect(within(details).getByText('Abendrot')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_claim_planned')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_basis_direct')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_valid_from')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_valid_until')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_source_user')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_source_assistant')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_source_context')).toBeInTheDocument();
  expect(within(details).getByText('com_ui_brain_source_context_count')).toBeInTheDocument();
  expect(within(details).getAllByRole('listitem')).toHaveLength(2);
});

test('a conflicting update preserves the draft and loads the current version', async () => {
  const error = new AxiosError('Conflict', 'CONFLICT', undefined, undefined, {
    status: 409,
  } as AxiosResponse);
  const update = jest
    .spyOn(dataService, 'updateBrainNode')
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ node: memory({ version: 3 }) });
  renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  await screen.findByRole('link', { name: /Pilot planen/ });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_brain_edit' }));
  const textbox = screen.getByLabelText('com_ui_brain_content_label');
  fireEvent.change(textbox, { target: { value: 'Mein geprüfter Entwurf' } });
  jest.mocked(dataService.getBrainNode).mockResolvedValue({
    node: memory({ text: 'Inzwischen geänderte Fassung', version: 2 }),
    edges: [],
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  expect(await screen.findByText('com_ui_brain_conflict')).toBeInTheDocument();
  expect(await screen.findByText('Inzwischen geänderte Fassung')).toBeInTheDocument();
  expect(textbox).toHaveValue('Mein geprüfter Entwurf');
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith(
      'node-one',
      expect.objectContaining({ text: 'Mein geprüfter Entwurf', version: 2 }),
    ),
  );
});

test('read-only users can explore sources but cannot create, edit or forget', async () => {
  mockCanWrite = false;
  renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  expect(await screen.findByRole('link', { name: /Pilot planen/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_brain_create' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_brain_edit' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_brain_forget' })).not.toBeInTheDocument();
});

test('a background refresh cannot silently upgrade the version of an open editing draft', async () => {
  const update = jest
    .spyOn(dataService, 'updateBrainNode')
    .mockResolvedValue({ node: memory({ version: 2 }) });
  const { client } = renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  await screen.findByRole('link', { name: /Pilot planen/ });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_brain_edit' }));
  await act(async () => {
    client.setQueryData([QueryKeys.brain, 'user-one', 'node', 'node-one'], {
      node: memory({ version: 2, text: 'Zwischenzeitlich geändert' }),
      edges: [],
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('node-one', expect.objectContaining({ version: 1 })),
  );
});

test('partial knowledge is labelled and later pages are loaded without duplicates', async () => {
  jest
    .mocked(dataService.getBrainGraph)
    .mockResolvedValueOnce({ ...graphFixture, nextCursor: 'page-two', total: 3 })
    .mockResolvedValueOnce({
      nodes: [memory({ id: 'third-node', title: 'Dritte Erinnerung' })],
      edges: graphFixture.edges,
      nextCursor: null,
      total: 3,
    });
  renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: 'com_ui_brain_load_more' }));
  expect(
    await within(screen.getByRole('list', { name: 'com_ui_brain_memories' })).findByText(
      'Dritte Erinnerung',
    ),
  ).toBeInTheDocument();
  expect(dataService.getBrainGraph).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: 'page-two' }),
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole('button', { name: 'com_ui_brain_load_more' })).not.toBeInTheDocument();
});

test('shows a live draft with generation-isolated details and no memory mutations', async () => {
  const draft = rebuildFixture();
  if (draft.rebuild) draft.rebuild.autoActivate = true;
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(draft);
  jest.mocked(dataService.getBrainHistory).mockResolvedValue({
    status: 'running',
    schemaVersion: 2,
    unit: 'chats',
    rebuildId: 'rebuild-one',
    autoActivate: true,
    total: 8,
    processed: 2,
    saved: 1,
    skipped: 0,
    available: true,
  });
  const update = jest.spyOn(dataService, 'updateBrainNode');
  const remove = jest.spyOn(dataService, 'deleteBrainNode');
  renderWorkspace();
  const list = await screen.findByRole('list', { name: 'com_ui_brain_memories' });
  expect(screen.getByText('com_ui_brain_rebuild_live_preview')).toBeInTheDocument();
  expect(dataService.getBrainGraph).toHaveBeenCalledTimes(1);
  expect(dataService.getBrainGraph).toHaveBeenCalledWith(
    expect.objectContaining({ generationId: 'rebuild-one' }),
    expect.any(AbortSignal),
  );
  fireEvent.click(within(list).getByRole('button', { name: /Projekt Abendrot/ }));
  await screen.findByRole('link', { name: /Pilot planen/ });
  expect(dataService.getBrainNode).toHaveBeenCalledWith(
    'node-one',
    expect.any(AbortSignal),
    'rebuild-one',
  );
  expect(screen.queryByRole('button', { name: /com_ui_brain_create/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /com_ui_brain_edit/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /com_ui_brain_forget/ })).not.toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await waitFor(() => expect(dataService.getBrainHistory).toHaveBeenCalledTimes(2), {
    timeout: 3500,
  });
  expect(dataService.getBrainRebuild).toHaveBeenCalledTimes(1);
});

test('switches from the live draft to fresh active knowledge after automatic completion', async () => {
  const draft = rebuildFixture();
  if (draft.rebuild) draft.rebuild.autoActivate = true;
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(draft);
  const running = {
    status: 'running' as const,
    schemaVersion: 2 as const,
    unit: 'chats' as const,
    rebuildId: 'rebuild-one',
    autoActivate: true,
    total: 8,
    processed: 2,
    saved: 1,
    skipped: 0,
    available: true,
  };
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(running);
  const draftNode = memory({ id: 'draft-node', title: 'Wissen im Entwurf' });
  const activeNode = memory({ id: 'activated-node', title: 'Automatisch aktiviertes Wissen' });
  jest.mocked(dataService.getBrainGraph).mockImplementation(async (params) => ({
    nodes: [params?.generationId ? draftNode : activeNode],
    edges: [],
    total: 1,
    nextCursor: null,
  }));
  const { client } = renderWorkspace();
  await within(await screen.findByRole('list', { name: 'com_ui_brain_memories' })).findByText(
    'Wissen im Entwurf',
  );
  client.setQueryData([QueryKeys.brain, 'user-one', 'graph', { query: '', limit: 500 }], {
    pages: [
      { nodes: [memory({ title: 'Veralteter Cache' })], edges: [], total: 1, nextCursor: null },
    ],
    pageParams: [undefined],
  });
  jest
    .mocked(dataService.getBrainRebuild)
    .mockResolvedValue({ rebuild: null, rollbackAvailable: true });
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue({ ...running, status: 'completed', processed: 8, saved: 4 });
  await act(async () => {
    await client.invalidateQueries([QueryKeys.brain, 'user-one', 'history']);
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole('list', { name: 'com_ui_brain_memories' })).getByText(
        'Automatisch aktiviertes Wissen',
      ),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText('Veralteter Cache')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_brain_rebuild_live_preview')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /com_ui_brain_create/ })).toBeEnabled();
  expect(dataService.getBrainGraph).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ generationId: 'rebuild-one' }),
    expect.any(AbortSignal),
  );
});

test('restarts live pagination after inserts instead of refetching stale follow-up cursors', async () => {
  jest.mocked(dataService.getBrainRebuild).mockResolvedValue(rebuildFixture());
  const running = {
    status: 'running' as const,
    schemaVersion: 2 as const,
    unit: 'chats' as const,
    rebuildId: 'rebuild-one',
    total: 8,
    processed: 1,
    saved: 0,
    skipped: 0,
    available: true,
  };
  jest.mocked(dataService.getBrainHistory).mockResolvedValue(running);
  jest
    .mocked(dataService.getBrainGraph)
    .mockResolvedValueOnce({ ...graphFixture, nextCursor: 'stale-cursor', total: 3 })
    .mockResolvedValueOnce({
      nodes: [memory({ id: 'page-two', title: 'Bisherige Folgeseite' })],
      edges: [],
      total: 3,
      nextCursor: null,
    });
  const { client } = renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: 'com_ui_brain_load_more' }));
  await within(screen.getByRole('list', { name: 'com_ui_brain_memories' })).findByText(
    'Bisherige Folgeseite',
  );
  jest.mocked(dataService.getBrainGraph).mockResolvedValue({
    nodes: [memory({ id: 'latest', title: 'Frisch gelerntes Wissen' })],
    edges: [],
    total: 4,
    nextCursor: 'fresh-cursor',
  });
  jest
    .mocked(dataService.getBrainHistory)
    .mockResolvedValue({ ...running, processed: 2, saved: 1 });
  await act(async () => {
    await client.invalidateQueries([QueryKeys.brain, 'user-one', 'history']);
  });
  await within(screen.getByRole('list', { name: 'com_ui_brain_memories' })).findByText(
    'Frisch gelerntes Wissen',
  );
  expect(dataService.getBrainGraph).toHaveBeenCalledTimes(3);
  expect(dataService.getBrainGraph).toHaveBeenLastCalledWith(
    expect.objectContaining({ generationId: 'rebuild-one', cursor: undefined }),
    expect.any(AbortSignal),
  );
  expect(screen.queryByText('Bisherige Folgeseite')).not.toBeInTheDocument();
});
