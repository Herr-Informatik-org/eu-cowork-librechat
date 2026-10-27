import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  MailWorkspaceContent,
  MailWorkspaceResult,
  MailWorkspaceStatus,
} from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import Workspace from '../Workspace';
import { consumeMailChat } from '../handoff';

let mockUser = { id: 'owner' };
let mockRows: MailWorkspaceResult[];
let mockStatus: MailWorkspaceStatus;
let mockContent: MailWorkspaceContent;
const mockFolders = [
  { id: 'done', displayName: '00_erledigt', childFolderCount: 0, canMoveTo: true },
];
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockRun = jest.fn();
const mockMove = jest.fn();
const mockSave = jest.fn();
const mockNext = jest.fn();
const mockResults = jest.fn();
const mockMutation = (mutate = jest.fn()) => ({
  mutate,
  mutateAsync: jest.fn(),
  isLoading: false,
  isError: false,
});
const mockActions = () => ({
  connect: mockMutation(),
  settings: mockMutation(),
  run: mockMutation(mockRun),
  pause: mockMutation(),
  disconnect: mockMutation(),
  priority: mockMutation(),
  move: mockMutation(mockMove),
  draft: mockMutation(mockSave),
  refresh: jest.fn(),
});
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useLocalize:
    () =>
    (key: keyof typeof mockTranslations, options: Record<string, string | number> = {}) =>
      Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
jest.mock('~/data-provider/Mail', () => ({
  useMailStatus: () => ({ data: mockStatus }),
  useMailResults: (params: object) => {
    mockResults(params);
    return {
      data: { pages: [{ results: mockRows }] },
      hasNextPage: true,
      fetchNextPage: mockNext,
      refetch: jest.fn(),
    };
  },
  useMailContent: () => ({ data: mockContent }),
  useMailFolders: () => ({ data: { folders: mockFolders } }),
  useMailActions: () => mockActions(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockUser = { id: 'owner' };
  Object.defineProperty(global.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000001',
    configurable: true,
  });
  mockRows = [
    {
      id: 'result',
      revision: 'result-revision',
      subject: 'Wartungsfenster bestätigen',
      sender: 'kunde@example.test',
      receivedAt: '2026-10-27T08:00:00Z',
      priority: 'important',
      action: 'reply',
      summary: 'Termin abstimmen',
      reason: 'Offene Rückfrage',
      questions: ['Passt der Termin?'],
      draftStatus: 'created',
    },
  ];
  mockStatus = {
    available: true,
    modelLabel: 'Standardmodell',
    connection: { connected: true, mailbox: 'owner@example.test' },
    settings: {
      enabled: true,
      consentVersion: '2026-10-27',
      mode: 'manual',
      weekdays: [1, 2, 3, 4, 5],
      startTime: '08:00',
      endTime: '17:00',
      timeZone: 'Europe/Zurich',
      intervalMinutes: 30,
      history: { mode: 'all' },
    },
    activity: {
      running: false,
      pending: 0,
      hasMore: false,
      history: { mode: 'all', processed: 315, pending: 0, hasMore: false, completed: true },
    },
    results: mockRows,
  };
  mockContent = {
    resultId: 'result',
    mailbox: 'owner@example.test',
    message: {
      subject: mockRows[0].subject,
      sender: mockRows[0].sender,
      receivedAt: mockRows[0].receivedAt,
      body: 'Bitte um Terminbestätigung.',
      bodyTruncated: false,
    },
    draft: {
      subject: 'Re: Termin',
      body: 'Entwurf\nOriginalverlauf',
      bodyTruncated: false,
      replyText: 'Entwurf',
      revision: 'opaque-revision',
    },
  };
});
const mount = () =>
  render(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
const chooseMail = () =>
  fireEvent.click(screen.getByRole('button', { name: /kunde@example.test/ }));

it('loads more results without triggering analysis on view or selection', () => {
  mount();
  chooseMail();
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Mails laden' }));
  expect(mockNext).toHaveBeenCalledTimes(1);
  expect(mockRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt prüfen' }));
  expect(mockRun).toHaveBeenCalledTimes(1);
});
it('requires a folder selection and explicit confirmation before moving', () => {
  mount();
  chooseMail();
  expect(screen.getByRole('button', { name: 'In Erledigt verschieben' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Erledigt-Ordner wählen' }));
  fireEvent.click(screen.getByRole('button', { name: '00_erledigt' }));
  fireEvent.click(screen.getByRole('button', { name: 'In Erledigt verschieben' }));
  expect(mockMove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt verschieben' }));
  expect(mockMove).toHaveBeenCalledWith(
    { id: 'result', folderId: 'done', revision: 'result-revision' },
    expect.any(Object),
  );
});
it('saves only the edited reply with the original revision on user click', () => {
  mount();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ }), {
    target: { value: 'Freigegebene Antwort' },
  });
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Entwurf in Outlook speichern' }));
  expect(mockSave).toHaveBeenCalledWith(
    { id: 'result', body: 'Freigegebene Antwort', revision: 'opaque-revision' },
    expect.any(Object),
  );
});
it('keeps legacy drafts read-only', () => {
  delete mockContent.draft!.revision;
  delete mockContent.draft!.replyText;
  mount();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  expect(screen.getByRole('button', { name: 'Antwort bearbeiten' })).toBeDisabled();
});
it('starts a fresh chat with an opaque handoff and no automatic submission', () => {
  mount();
  chooseMail();
  fireEvent.click(screen.getByRole('button', { name: 'Im neuen Chat überarbeiten' }));
  expect(mockNewConversation).toHaveBeenCalledTimes(1);
  const url = mockNavigate.mock.calls[0][0];
  expect(url).toMatch(/^\/c\/new\?mailReview=/);
  expect(url).not.toContain('submit');
  expect(url).not.toContain('Termin');
  const token = new URL(url, 'http://localhost').searchParams.get('mailReview')!;
  expect(consumeMailChat('owner', token)).toContain('Bitte um Terminbestätigung.');
  expect(mockRun).not.toHaveBeenCalled();
});
it('clears selected private content on account switch', () => {
  const view = mount();
  chooseMail();
  expect(screen.getByText('Bitte um Terminbestätigung.')).toBeInTheDocument();
  mockUser = { id: 'other' };
  mockRows = [];
  mockStatus = { ...mockStatus, connection: { connected: false } };
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  expect(screen.queryByText('Bitte um Terminbestätigung.')).not.toBeInTheDocument();
});
it('does not render content with a foreign mailbox binding', () => {
  mockContent = { ...mockContent, mailbox: 'other@example.test' };
  mount();
  chooseMail();
  expect(screen.queryByText('Bitte um Terminbestätigung.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Im neuen Chat überarbeiten' })).toBeDisabled();
});
it('searches on the server instead of filtering only the loaded page', async () => {
  mount();
  fireEvent.change(screen.getByRole('textbox', { name: /Absender, Betreff/ }), {
    target: { value: 'Kunde 315' },
  });
  await waitFor(() =>
    expect(mockResults).toHaveBeenCalledWith(expect.objectContaining({ search: 'Kunde 315' })),
  );
});
