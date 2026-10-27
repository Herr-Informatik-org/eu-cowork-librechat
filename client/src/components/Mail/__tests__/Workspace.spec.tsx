import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  MailWorkspaceContent,
  MailWorkspaceResult,
  MailWorkspaceStatus,
  MailWorkspaceMoveJob,
} from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import Workspace from '../Workspace';
import { consumeMailChat } from '../handoff';

let mockUser = { id: 'owner' };
let mockRows: MailWorkspaceResult[];
let mockStatus: MailWorkspaceStatus;
let mockContent: MailWorkspaceContent;
let mockJobs: MailWorkspaceMoveJob[];
let mockJobsError = false;
const mockFolders = [
  { id: 'done', displayName: '00_erledigt', childFolderCount: 0, canMoveTo: true },
];
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockRun = jest.fn();
const mockPause = jest.fn();
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
  pause: mockMutation(mockPause),
  disconnect: mockMutation(),
  priority: mockMutation(),
  move: mockMutation(),
  enqueueMove: mockMutation(mockMove),
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
  useMailMoveJobs: () => ({ data: { jobs: mockJobs }, isError: mockJobsError }),
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
  mockJobs = [];
  mockJobsError = false;
  mockMove.mockReset();
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
    {
      requestId: '00000000-0000-4000-8000-000000000001',
      folderId: 'done',
      items: [{ id: 'result', revision: 'result-revision' }],
    },
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

const chooseFolder = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Erledigt-Ordner wählen' }));
  fireEvent.click(screen.getByRole('button', { name: '00_erledigt' }));
};
const exampleJob = (status: MailWorkspaceMoveJob['status'] = 'running'): MailWorkspaceMoveJob => ({
  id: 'move-job',
  status,
  folderName: '00_erledigt',
  total: 2,
  completed: 1,
  failed: status === 'partial' ? 1 : 0,
  createdAt: '2026-10-27T09:00:00Z',
  updatedAt: '2026-10-27T09:01:00Z',
  items: [
    { id: 'first', subject: 'Bereits erledigte Mail', status: 'completed' },
    {
      id: 'second',
      subject: 'Weitere Mail',
      status: status === 'partial' ? 'uncertain' : 'queued',
      error: status === 'partial' ? 'Ausgang konnte nicht bestätigt werden.' : undefined,
    },
  ],
});
it('selects only loaded open messages and confirms exact snapshots and folder', () => {
  mockRows = [
    mockRows[0],
    { ...mockRows[0], id: 'second', revision: 'second-revision', subject: 'Zweite Mail' },
    { ...mockRows[0], id: 'done', subject: 'Schon erledigt', moveStatus: 'completed' },
  ];
  mount();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Alle 2 geladenen offenen Mails auswählen' }),
  );
  chooseFolder();
  fireEvent.click(screen.getByRole('button', { name: 'Auswahl verschieben' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    '2 ausgewählte Originalmails in «00_erledigt»',
  );
  expect(mockMove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt verschieben' }));
  expect(mockMove).toHaveBeenCalledWith(
    {
      requestId: expect.any(String),
      folderId: 'done',
      items: [
        { id: 'result', revision: 'result-revision' },
        { id: 'second', revision: 'second-revision' },
      ],
    },
    expect.any(Object),
  );
  expect(mockNext).not.toHaveBeenCalled();
});
it('limits select-all to 100 loaded messages and does not select unseen pages', () => {
  mockRows = Array.from({ length: 101 }, (_, index) => ({
    ...mockRows[0],
    id: `mail-${index}`,
    subject: `Mail ${index}`,
  }));
  mount();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Erste 100 geladene offene Mails auswählen' }),
  );
  expect(screen.getByText('100 ausgewählt')).toBeInTheDocument();
  expect(
    screen.getByRole('checkbox', { name: '«Mail 100» zum Verschieben auswählen' }),
  ).not.toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: '«Mail 100» zum Verschieben auswählen' }),
  ).toBeDisabled();
  expect(mockNext).not.toHaveBeenCalled();
});
it('releases the confirmation after acceptance without claiming the mails have moved', () => {
  mockMove.mockImplementation((_request, options: { onSuccess: () => void }) =>
    options.onSuccess(),
  );
  mount();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Alle 1 geladenen offenen Mails auswählen' }),
  );
  chooseFolder();
  fireEvent.click(screen.getByRole('button', { name: 'Auswahl verschieben' }));
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt verschieben' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(
    screen.getByText('Verschiebeauftrag angenommen. Der Fortschritt wird oben angezeigt.'),
  ).toBeInTheDocument();
  expect(screen.getByText('0 ausgewählt')).toBeInTheDocument();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  expect(screen.getByRole('button', { name: 'Antwort bearbeiten' })).toBeEnabled();
});
it('restores background progress on mount without blocking draft edits or navigation', () => {
  mockJobs = [exampleJob()];
  mount();
  expect(screen.getByRole('progressbar', { name: 'Verschiebeaufträge' })).toHaveAttribute(
    'value',
    '1',
  );
  expect(screen.getByRole('progressbar', { name: 'Verschiebeaufträge' })).toHaveAttribute(
    'max',
    '2',
  );
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  expect(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Im neuen Chat überarbeiten' }));
  expect(mockNavigate).toHaveBeenCalled();
  expect(mockMove).not.toHaveBeenCalled();
});
it('preserves an unsaved reply through queue progress, changed revision and removal from open results', () => {
  mockJobs = [exampleJob()];
  const view = mount();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ }), {
    target: { value: 'Meine noch nicht gespeicherte Antwort' },
  });
  expect(
    within(screen.getByRole('article', { name: 'Mail prüfen' })).getByRole('combobox', {
      name: 'Priorität',
    }),
  ).toBeDisabled();
  mockRows = [{ ...mockRows[0], revision: 'moved-revision', moveStatus: 'completed' }];
  mockContent = { ...mockContent, draft: undefined };
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  expect(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ })).toHaveValue(
    'Meine noch nicht gespeicherte Antwort',
  );
  mockRows = [];
  mockJobs = [{ ...exampleJob('completed'), completed: 2 }];
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  expect(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ })).toHaveValue(
    'Meine noch nicht gespeicherte Antwort',
  );
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockMove).not.toHaveBeenCalled();
  expect(JSON.stringify(localStorage)).not.toContain('Meine noch nicht gespeicherte Antwort');
  expect(JSON.stringify(sessionStorage)).not.toContain('Meine noch nicht gespeicherte Antwort');
  fireEvent.click(screen.getByRole('button', { name: 'Entwurf in Outlook speichern' }));
  expect(mockSave).toHaveBeenCalledWith(
    { id: 'result', body: 'Meine noch nicht gespeicherte Antwort', revision: 'opaque-revision' },
    expect.any(Object),
  );
});
it('blocks single and bulk moves containing an open editor while other mails remain usable', () => {
  mockRows = [mockRows[0], { ...mockRows[0], id: 'second', sender: 'other@example.test' }];
  mount();
  chooseFolder();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ }), {
    target: { value: 'Persönliche Überarbeitung' },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Alle 2 geladenen offenen Mails auswählen' }),
  );
  expect(screen.getByRole('button', { name: 'In Erledigt verschieben' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Auswahl verschieben' })).toBeDisabled();
  expect(screen.getAllByText(/Vor dem Verschieben den Entwurf speichern/).length).toBeGreaterThan(
    0,
  );
  fireEvent.click(screen.getByRole('button', { name: /other@example.test/ }));
  expect(screen.getByRole('button', { name: 'In Erledigt verschieben' })).toBeEnabled();
  chooseMail();
  expect(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ })).toHaveValue(
    'Persönliche Überarbeitung',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
  expect(screen.getByRole('button', { name: 'Auswahl verschieben' })).toBeEnabled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockMove).not.toHaveBeenCalled();
});
it.each(['disconnect', 'mailbox', 'account'])('clears editor snapshots after %s', (change) => {
  const view = mount();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ }), {
    target: { value: 'Private ungespeicherte Antwort' },
  });
  if (change === 'account') mockUser = { id: 'other' };
  else
    mockStatus = {
      ...mockStatus,
      connection:
        change === 'disconnect'
          ? { connected: false }
          : { connected: true, mailbox: 'other@example.test' },
    };
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  expect(screen.queryByDisplayValue('Private ungespeicherte Antwort')).not.toBeInTheDocument();
  mockUser = { id: 'owner' };
  mockStatus = { ...mockStatus, connection: { connected: true, mailbox: 'owner@example.test' } };
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  expect(screen.queryByDisplayValue('Private ungespeicherte Antwort')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Antwort bearbeiten' })).toBeEnabled();
});
it('shows per-message uncertainty and never automatically retries the operation', () => {
  mockJobs = [exampleJob('partial')];
  mount();
  fireEvent.click(screen.getByText(/Verschiebeauftrag mit Hinweisen beendet ·/));
  fireEvent.click(screen.getByText('Hinweise zu 1 Mails anzeigen'));
  expect(screen.getByText(/Ausgang konnte nicht bestätigt werden/)).toBeVisible();
  expect(screen.getByText(/Für diese Mail wird kein zweiter Versuch/)).toBeVisible();
  expect(mockMove).not.toHaveBeenCalled();
});
it('keeps confirmation snapshots unchanged when a newer revision arrives', () => {
  const view = mount();
  chooseMail();
  chooseFolder();
  fireEvent.click(screen.getByRole('button', { name: 'In Erledigt verschieben' }));
  mockRows = [{ ...mockRows[0], revision: 'new-revision' }];
  view.rerender(
    <MemoryRouter>
      <Workspace />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt verschieben' }));
  expect(mockMove.mock.calls[0][0].items).toEqual([{ id: 'result', revision: 'result-revision' }]);
});
it('clears selection when the result filter changes', () => {
  mount();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Alle 1 geladenen offenen Mails auswählen' }),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Bearbeitungsstand' }), {
    target: { value: 'done' },
  });
  expect(screen.getByText('0 ausgewählt')).toBeInTheDocument();
});
it('keeps reading available if the background status request fails', () => {
  mockJobsError = true;
  mount();
  expect(
    screen.getByText(/Bereits angenommene Aufträge können weiterhin laufen/),
  ).toBeInTheDocument();
  chooseMail();
  expect(screen.getByText('Bitte um Terminbestätigung.')).toBeInTheDocument();
  expect(mockMove).not.toHaveBeenCalled();
});

it('stops queued operations only when the user requests it', () => {
  mockJobs = [exampleJob()];
  mount();
  expect(mockPause).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Aufträge und Analyse anhalten' }));
  expect(mockPause).toHaveBeenCalledTimes(1);
});
