import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { BrainQuality } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import Quality from '../Quality';
import { memory, rebuildFixture } from './fixtures';

jest.mock('librechat-data-provider', () => {
  const actual: typeof import('librechat-data-provider') =
    jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});
jest.mock('~/data-provider/Auth', () => ({ useGetUserQuery: () => ({ data: { id: 'owner' } }) }));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default:
    () =>
    (key: keyof typeof mockTranslations, values: Record<string, string | number> = {}) =>
      Object.entries(values).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
const preview: BrainQuality = {
  revision: 7,
  total: 2,
  truncated: false,
  findings: [
    {
      id: 'scope',
      nodeId: 'node-one',
      version: 1,
      reason: 'general_preference_scope',
      explanation: 'Allgemeine Vorliebe aus eigener Aussage.',
      before: memory({
        title: 'Kurze Antworten',
        kind: 'preference',
        scope: 'Mail: kunde@example.test',
      }),
      proposedChanges: { scope: null },
      reviewOnly: false,
    },
    {
      id: 'duplicate',
      nodeId: 'node-two',
      version: 1,
      reason: 'duplicate_candidate',
      explanation: 'Bedeutung muss geprüft werden.',
      before: memory({ id: 'node-two', title: 'Mögliche Dublette' }),
      reviewOnly: true,
    },
  ],
};
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  render(
    <QueryClientProvider client={client}>
      <Quality enabled busy={false} onSelect={jest.fn()} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  jest.spyOn(dataService, 'getBrainQuality').mockResolvedValue(preview);
  jest.spyOn(dataService, 'applyBrainQuality').mockResolvedValue(rebuildFixture('ready'));
  jest
    .spyOn(dataService, 'activateBrainRebuild')
    .mockResolvedValue({ rebuild: null, rollbackAvailable: true });
});
afterEach(() => jest.restoreAllMocks());

test('loads only on request, presents review-only findings, and prepares only an explicit selection', async () => {
  const client = mount();
  expect(dataService.getBrainQuality).not.toHaveBeenCalled();
  expect(dataService.applyBrainQuality).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Wissen prüfen und bereinigen'));
  const choice = await screen.findByRole('checkbox', { name: 'Kurze Antworten' });
  expect(choice).not.toBeChecked();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByText('Mögliche Dublette')).toBeVisible();
  expect(screen.getByText('Mail: kunde@example.test')).toBeVisible();
  expect(screen.getByText('Allgemein')).toBeVisible();
  fireEvent.click(choice);
  fireEvent.click(screen.getByRole('button', { name: 'Auswahl vorbereiten (1)' }));
  await waitFor(() => expect(dataService.applyBrainQuality).toHaveBeenCalledWith(7, ['scope']));
  await waitFor(() =>
    expect(client.getQueryData([QueryKeys.brain, 'owner', 'rebuild'])).toEqual(
      rebuildFixture('ready'),
    ),
  );
  await waitFor(() =>
    expect(screen.getByText('Wissen prüfen und bereinigen').closest('details')).not.toHaveAttribute(
      'open',
    ),
  );
  expect(dataService.activateBrainRebuild).not.toHaveBeenCalled();
});

test('drops selections when a refreshed preview has a different revision', async () => {
  mount();
  fireEvent.click(screen.getByText('Wissen prüfen und bereinigen'));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Kurze Antworten' }));
  jest.mocked(dataService.getBrainQuality).mockResolvedValue({ ...preview, revision: 8 });
  fireEvent.click(screen.getByRole('button', { name: 'Erneut prüfen' }));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Kurze Antworten' })).not.toBeChecked(),
  );
  expect(screen.getByRole('button', { name: 'Auswahl vorbereiten (0)' })).toBeDisabled();
  expect(dataService.applyBrainQuality).not.toHaveBeenCalled();
});
