import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import type { BrainRecall, BrainUsage } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import Usage, { MessageUsage, usageFromRecalls } from '../Usage';

const mockOpen = jest.fn();
let mockShareId: string | undefined;
jest.mock('librechat-data-provider', () => {
  const actual: typeof import('librechat-data-provider') =
    jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('../Dialog', () => ({
  useOptionalBrainDialog: () => ({ showBrain: mockOpen, triggerRef: { current: null } }),
}));
jest.mock('~/Providers', () => ({ useShareContext: () => ({ shareId: mockShareId }) }));
jest.mock('~/data-provider/Auth', () => ({ useGetUserQuery: () => ({ data: { id: 'owner' } }) }));
jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useLocalize:
    () =>
    (key: keyof typeof mockTranslations, values: Record<string, string | number> = {}) =>
      Object.entries(values).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
const usage: BrainUsage = {
  status: 'available',
  count: 1,
  items: [
    {
      id: 'node-one',
      title: 'Kurze Antworten',
      text: 'Antworten auf Deutsch und ohne Floskeln.',
      kind: 'preference',
      scope: null,
      status: 'active',
      basis: 'confirmed',
      validFrom: '2026-10-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
      sources: [{ type: 'chat', conversationId: 'source-chat', sourceMessageId: 'source-message' }],
    },
  ],
};
const recall = (messageId: string, title: string, provided = true): BrainRecall => ({
  id: messageId,
  conversationId: 'chat',
  messageId,
  nodeIds: ['node-one'],
  provided,
  items: [{ ...usage.items![0], title }],
  query: '',
  estimatedTokens: 120,
  hasMore: false,
  stopReason: 'complete',
  createdAt: '2026-10-30T10:00:00Z',
});
function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockShareId = undefined;
});
afterEach(() => jest.restoreAllMocks());

test('shows no permanent explanation and opens provided content, source and validity on demand', async () => {
  render(<Usage usage={usage} />);
  expect(screen.queryByText('Antworten auf Deutsch und ohne Floskeln.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Brain-Info' }));
  expect(await screen.findByText('Antworten auf Deutsch und ohne Floskeln.')).toBeVisible();
  expect(screen.getByText(mockTranslations.com_ui_brain_valid_until)).toBeVisible();
  expect(
    screen.getByRole('link', { name: mockTranslations.com_ui_brain_open_chat }),
  ).toHaveAttribute('href', '/c/source-chat');
  fireEvent.click(screen.getByRole('button', { name: 'Im Brain ansehen' }));
  expect(mockOpen).toHaveBeenCalledWith('node-one');
  expect(screen.queryByText('Antworten auf Deutsch und ohne Floskeln.')).not.toBeInTheDocument();
});

test('matches only confirmed provided context for the exact assistant response', () => {
  const records = [
    recall('latest-other', 'Falsche Antwort'),
    recall('target', 'Nur gesucht', false),
    recall('target', 'Passender Kontext'),
  ];
  expect(usageFromRecalls(records, 'target')?.items?.map((item) => item.title)).toEqual([
    'Passender Kontext',
  ]);
  expect(usageFromRecalls(records, 'missing')).toBeUndefined();
  expect(
    usageFromRecalls([{ ...recall('legacy', 'Alt'), provided: undefined }], 'legacy'),
  ).toBeUndefined();
});

test('loads a chat trace only after opening and ignores the latest unrelated recall', async () => {
  jest.spyOn(dataService, 'getBrainStatus').mockResolvedValue({ enabled: true });
  const getRecalls = jest.spyOn(dataService, 'getBrainRecalls').mockResolvedValue({
    recalls: [recall('latest-other', 'Falsche Antwort'), recall('target', 'Passender Kontext')],
  });
  render(
    <Wrapper>
      <MessageUsage conversationId="chat" messageId="target" />
    </Wrapper>,
  );
  const trigger = await screen.findByRole('button', { name: 'Brain-Info' });
  expect(getRecalls).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(await screen.findByText('Passender Kontext')).toBeVisible();
  expect(screen.queryByText('Falsche Antwort')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(getRecalls).toHaveBeenCalledWith('chat', expect.any(AbortSignal), 'target'),
  );
});

test('does not fetch private traces for shared conversations', async () => {
  mockShareId = 'public-share';
  const status = jest.spyOn(dataService, 'getBrainStatus');
  const getRecalls = jest.spyOn(dataService, 'getBrainRecalls');
  render(
    <Wrapper>
      <MessageUsage conversationId="chat" messageId="target" />
    </Wrapper>,
  );
  expect(screen.queryByRole('button', { name: 'Brain-Info' })).not.toBeInTheDocument();
  expect(status).not.toHaveBeenCalled();
  expect(getRecalls).not.toHaveBeenCalled();
});
