import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { deserialize, serialize } from 'node:v8';
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
let mockPending = { draft: 0, followup: 0 };
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
jest.mock('../Followup', () => ({
  MailFollowupSettings: () => <span data-testid="odoo-settings" />,
  MailFollowupAction: () => <span data-testid="odoo-action" />,
}));
jest.mock('../DraftRequest', () => ({
  MailDraftRequest: () => <span data-testid="draft-request" />,
}));
jest.mock('../Attachments', () => ({ MailAttachments: () => null }));
jest.mock('~/data-provider/Mail', () => ({
  useMailPendingActions: () => mockPending,
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

const originalStructuredClone = globalThis.structuredClone;
beforeAll(() => {
  globalThis.structuredClone ??= <T,>(value: T): T => deserialize(serialize(value)) as T;
});
afterAll(() => {
  globalThis.structuredClone = originalStructuredClone;
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockUser = { id: 'owner' };
  mockJobs = [];
  mockJobsError = false;
  mockPending = { draft: 0, followup: 0 };
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
  mockMove.mockImplementation((_request, options: { onSuccess: () => void }) => {
    mockJobs = [exampleJob('queued')];
    options.onSuccess();
  });
  mount();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Alle 1 geladenen offenen Mails auswählen' }),
  );
  chooseFolder();
  fireEvent.click(screen.getByRole('button', { name: 'Auswahl verschieben' }));
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt verschieben' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('status', { name: 'Verschiebeaufträge' })).getByText(
      mockTranslations.com_ui_mail_job_queued,
    ),
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
  fireEvent.click(screen.getByText('1 mit Hinweis · Details'));
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

it('keeps move and analysis progress together with collapsed statistics', () => {
  mockJobs = [exampleJob()];
  mockStatus.activity.running = true;
  mount();
  const activity = screen.getByRole('region', { name: 'Aufträge und Analyse' });
  expect(within(activity).getByText('Analyse läuft')).toBeVisible();
  expect(within(activity).getByText('1/2')).toBeVisible();
  expect(screen.getByText('315 ältere Einträge abgearbeitet')).not.toBeVisible();
  fireEvent.click(within(activity).getByText('Details'));
  expect(screen.getByText('315 ältere Einträge abgearbeitet')).toBeVisible();
});
it('shows previous uncertain moves even when a newer job completed', () => {
  mockJobs = [exampleJob('completed'), { ...exampleJob('partial'), id: 'old-job' }];
  mount();
  expect(screen.getByText('1 mit Hinweis · Details')).toBeVisible();
  expect(screen.queryByText(/Ausgang konnte nicht bestätigt werden/)).not.toBeVisible();
});
it('navigates loaded mails and toggles selection without starting an action', () => {
  mockRows.push({
    ...mockRows[0],
    id: 'second',
    subject: 'Zweite Mail',
    sender: 'other@example.test',
  });
  mount();
  const workspace = screen.getByRole('main');
  fireEvent.keyDown(workspace, { key: 'j' });
  const first = screen.getByRole('button', { name: /kunde@example.test/ });
  const second = screen.getByRole('button', { name: /other@example.test/ });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'x' });
  expect(screen.getByText('1 ausgewählt')).toBeVisible();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(second).toHaveFocus();
  expect(second).toHaveAttribute('aria-pressed', 'true');
  fireEvent.keyDown(second, { key: 'k' });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(screen.getByText('0 ausgewählt')).toBeVisible();
  expect(mockMove).not.toHaveBeenCalled();
  expect(mockRun).not.toHaveBeenCalled();
});
it('uses the move shortcut only to confirm the explicit multi-selection', () => {
  mockRows.push({
    ...mockRows[0],
    id: 'second',
    subject: 'Zweite Mail',
    sender: 'other@example.test',
  });
  mount();
  chooseFolder();
  const workspace = screen.getByRole('main');
  fireEvent.keyDown(workspace, { key: 'j' });
  fireEvent.keyDown(workspace, { key: 'x' });
  fireEvent.keyDown(workspace, { key: 'j' });
  fireEvent.keyDown(workspace, { key: 'e' });
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveTextContent('1 ausgewählte Originalmails');
  expect(dialog).toHaveTextContent('Wartungsfenster bestätigen');
  expect(dialog).not.toHaveTextContent('Zweite Mail');
  fireEvent.keyDown(dialog, { key: 'e' });
  expect(mockMove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Jetzt verschieben' }));
  expect(mockMove).toHaveBeenCalledTimes(1);
});
it('never uses shortcuts to move an edited or unconfigured mail', () => {
  mount();
  chooseMail();
  const workspace = screen.getByRole('main');
  fireEvent.keyDown(workspace, { key: 'e' });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  chooseFolder();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  fireEvent.keyDown(workspace, { key: 'e' });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(mockMove).not.toHaveBeenCalled();
});
it('returns focus to the mail after cancelling a keyboard move confirmation', () => {
  mount();
  chooseFolder();
  chooseMail();
  const row = screen.getByRole('button', { name: /kunde@example.test/ });
  row.focus();
  fireEvent.keyDown(row, { key: 'e' });
  const dialog = screen.getByRole('alertdialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(row).toHaveFocus();
  fireEvent.keyDown(row, { key: 'x' });
  expect(screen.getByText('1 ausgewählt')).toBeVisible();
  expect(mockMove).not.toHaveBeenCalled();
});
it('does not hijack text input, modifiers, repeats, composing or other dialogs', () => {
  mockRows.push({
    ...mockRows[0],
    id: 'second',
    subject: 'Zweite Mail',
    sender: 'other@example.test',
  });
  mount();
  chooseMail();
  const workspace = screen.getByRole('main');
  const search = screen.getByRole('textbox', { name: /Absender, Betreff/ });
  fireEvent.keyDown(workspace, { key: '/' });
  expect(search).toHaveFocus();
  for (const key of ['j', 'x', 'e', '/']) fireEvent.keyDown(search, { key });
  fireEvent.keyDown(workspace, { key: 'j', ctrlKey: true });
  fireEvent.keyDown(workspace, { key: 'j', metaKey: true });
  fireEvent.keyDown(workspace, { key: 'j', altKey: true });
  fireEvent.keyDown(workspace, { key: 'j', shiftKey: true });
  fireEvent.keyDown(workspace, { key: 'j', isComposing: true });
  fireEvent.keyDown(workspace, { key: 'x', repeat: true });
  expect(screen.getByRole('button', { name: /kunde@example.test/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByText('0 ausgewählt')).toBeVisible();
  const dialog = document.createElement('section');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  fireEvent.keyDown(workspace, { key: 'j' });
  expect(screen.getByRole('button', { name: /kunde@example.test/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  dialog.remove();
  expect(mockMove).not.toHaveBeenCalled();
});
it('opens scoped shortcut help and returns focus after Escape', () => {
  mount();
  chooseMail();
  const row = screen.getByRole('button', { name: /kunde@example.test/ });
  row.focus();
  fireEvent.keyDown(row, { key: '?', shiftKey: true });
  const dialog = screen.getByRole('dialog', { name: 'Tastenkürzel' });
  expect(dialog).toHaveTextContent('Nächste geladene Mail');
  const close = within(dialog).getByRole('button', { name: 'Schliessen' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'x' });
  expect(screen.getByText('0 ausgewählt')).toBeVisible();
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(row).toHaveFocus();
});

it('keeps character shortcuts out of draft editors and mail iframe focus', () => {
  mockRows.push({ ...mockRows[0], id: 'second', sender: 'other@example.test' });
  mount();
  chooseMail();
  fireEvent.click(screen.getByRole('tab', { name: 'Entwurf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Antwort bearbeiten' }));
  const editor = screen.getByRole('textbox', { name: /Hier bearbeitest du nur/ });
  for (const key of ['j', 'x', 'e', '/', 'Escape']) fireEvent.keyDown(editor, { key });
  expect(editor).toBeInTheDocument();
  expect(screen.getByText('0 ausgewählt')).toBeVisible();
  const frame = document.createElement('iframe');
  screen.getByRole('main').appendChild(frame);
  frame.focus();
  fireEvent.keyDown(screen.getByRole('main'), { key: 'j' });
  expect(screen.getByRole('button', { name: /kunde@example.test/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  frame.remove();
  expect(mockMove).not.toHaveBeenCalled();
});

it('keeps pending draft and task work visible while reading another mail', () => {
  mockPending = { draft: 1, followup: 1 };
  mockStatus.odooAvailable = true;
  mount();
  chooseMail();
  expect(screen.getByText(/Entwurf wird erstellt/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Im neuen Chat überarbeiten' })).toBeEnabled();
});

it.each([undefined, false])(
  'hides all Odoo controls without explicit availability (%s)',
  (value) => {
    mockStatus.odooAvailable = value;
    mockPending = { draft: 1, followup: 1 };
    mount();
    chooseMail();
    expect(screen.queryByTestId('odoo-action')).not.toBeInTheDocument();
    expect(screen.getByTestId('draft-request')).toBeInTheDocument();
    expect(screen.getByText(/Entwurf wird erstellt/)).toBeVisible();
    expect(screen.queryByText(/Odoo-Auftrag läuft/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Einstellungen' }));
    expect(screen.queryByTestId('odoo-settings')).not.toBeInTheDocument();
  },
);

it('shows Odoo controls only when the server explicitly enables them', () => {
  mockStatus.odooAvailable = true;
  mount();
  chooseMail();
  expect(screen.getByTestId('odoo-action')).toBeInTheDocument();
  expect(screen.getByTestId('draft-request')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Einstellungen' }));
  expect(screen.getByTestId('odoo-settings')).toBeInTheDocument();
});
