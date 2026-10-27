import { fireEvent, render, screen } from '@testing-library/react';
import type {
  MailFollowupConfiguration,
  MailFollowupPreview,
  MailWorkspaceResult,
} from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import { MailFollowupAction, MailFollowupSettings, safeOdooTaskUrl } from '../Followup';
import { MailDraftRequest, safeOutlookDraftUrl } from '../DraftRequest';
import { MailAttachments } from '../Attachments';

const mockPrepare = jest.fn();
const mockCommit = jest.fn();
const mockDraft = jest.fn();
const mockAttachments = jest.fn();
const mockSaveSettings = jest.fn();
let mockConfiguration: MailFollowupConfiguration | undefined;
let mockPreview: MailFollowupPreview | undefined;
const result: MailWorkspaceResult = {
  id: 'mail-one',
  revision: 'revision-one',
  subject: 'Wartung',
  sender: 'kunde@example.test',
  receivedAt: '2026-10-27T12:00:00Z',
  priority: 'normal',
  action: 'reply',
  summary: 'Termin absprechen',
  reason: 'Offene Anfrage',
  questions: [],
  draftStatus: 'none',
};
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key] || key,
}));
jest.mock('~/data-provider/Mail', () => ({
  useMailFollowupActions: () => ({
    prepare: { mutate: mockPrepare, data: mockPreview },
    commit: { mutate: mockCommit, reset: jest.fn() },
    settings: { mutate: mockSaveSettings, reset: jest.fn() },
  }),
  useMailFollowupSettings: () => ({ data: mockConfiguration }),
  useMailFollowupProjects: () => ({ data: undefined }),
  useMailDraftRequest: () => ({ mutate: mockDraft }),
  useMailAttachments: (...args: Parameters<typeof mockAttachments>) => mockAttachments(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPreview = undefined;
  mockConfiguration = undefined;
  mockAttachments.mockReturnValue({ data: undefined });
  Object.defineProperty(global.crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000001',
    configurable: true,
  });
});

test.each(['todo', 'project'] as const)(
  'initializes saved Odoo %s settings without writing',
  (mode) => {
    const view = render(<MailFollowupSettings />);
    mockConfiguration = {
      profiles: [{ id: 'odoo-technik', label: 'Technik' }],
      settings: {
        profile: 'odoo-technik',
        mode,
        userName: 'Testperson',
        ...(mode === 'project' ? { projectId: 22, projectName: 'Projekt GL' } : {}),
      },
    };
    view.rerender(<MailFollowupSettings />);
    const details = view.container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(screen.getByLabelText('Aufgaben erfassen in')).toHaveValue(mode);
    expect(screen.getByLabelText('Freigegebenes Profil')).toHaveValue('odoo-technik');
    if (mode === 'project') expect(screen.getByLabelText('Odoo-Projekt')).toHaveValue('22');
    expect(mockSaveSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aufgabenablage speichern' }));
    expect(mockSaveSettings).toHaveBeenCalledWith({
      profile: 'odoo-technik',
      mode,
      ...(mode === 'project' ? { projectId: 22 } : {}),
    });
  },
);

test('preserves unsaved Odoo settings on refresh and clears a project when changing profile', () => {
  mockConfiguration = {
    profiles: [
      { id: 'odoo-technik', label: 'Technik' },
      { id: 'odoo-admin', label: 'Admin' },
    ],
    settings: {
      profile: 'odoo-technik',
      mode: 'project',
      projectId: 22,
      projectName: 'Projekt GL',
      userName: 'Testperson',
    },
  };
  const view = render(<MailFollowupSettings />);
  const details = view.container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  fireEvent.change(screen.getByLabelText('Aufgaben erfassen in'), { target: { value: 'todo' } });
  mockConfiguration = { ...mockConfiguration };
  view.rerender(<MailFollowupSettings />);
  expect(screen.getByLabelText('Aufgaben erfassen in')).toHaveValue('todo');
  fireEvent.change(screen.getByLabelText('Aufgaben erfassen in'), { target: { value: 'project' } });
  fireEvent.change(screen.getByLabelText('Freigegebenes Profil'), {
    target: { value: 'odoo-admin' },
  });
  expect(screen.getByRole('button', { name: 'Aufgabenablage speichern' })).toBeDisabled();
  expect(screen.queryByRole('option', { name: 'Projekt GL' })).not.toBeInTheDocument();
});

test('only prepares Odoo after a click and never commits without review', () => {
  const view = render(<MailFollowupAction result={result} />);
  expect(mockPrepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Für später erfassen'));
  expect(mockPrepare).toHaveBeenCalledWith(
    { id: result.id, revision: result.revision },
    expect.any(Object),
  );
  mockPreview = {
    token: 'owner-bound-token',
    title: 'Neue Wartungsanfrage',
    body: '<script>not executable</script>',
    targetLabel: 'Projekt GL',
    candidates: [{ id: 42, name: 'Wartung Kunde' }],
    expiresAt: '2026-10-27T14:00:00Z',
    writeAvailable: true,
  };
  view.rerender(<MailFollowupAction result={result} />);
  expect(mockCommit).not.toHaveBeenCalled();
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByLabelText('Wartung Kunde'));
  fireEvent.click(screen.getByText('Als interne Notiz ergänzen'));
  expect(mockCommit).toHaveBeenCalledWith({ token: 'owner-bound-token', taskId: 42 });
});

test.each([false, undefined])(
  'blocks Odoo writes without explicit safe capability (%s)',
  (available) => {
    mockPreview = {
      token: 'owner-bound-token',
      title: 'Neue Wartungsanfrage',
      body: 'Mailtext',
      targetLabel: 'Projekt GL',
      candidates: [],
      expiresAt: '2026-10-27T14:00:00Z',
      ...(available !== undefined ? { writeAvailable: available } : {}),
      writeReason: 'Sichere Odoo-Schreibfunktion fehlt.',
    } as MailFollowupPreview;
    render(<MailFollowupAction result={result} />);
    fireEvent.click(screen.getByText('Für später erfassen'));
    const submit = screen.getByRole('button', { name: 'Neue Aufgabe erstellen' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/es wurde nichts in Odoo gespeichert/)).toHaveTextContent(
      'Sichere Odoo-Schreibfunktion fehlt.',
    );
    fireEvent.click(submit);
    expect(mockCommit).not.toHaveBeenCalled();
  },
);

test('changing mail discards the previous Odoo confirmation panel', () => {
  const view = render(<MailFollowupAction result={result} />);
  fireEvent.click(screen.getByText('Für später erfassen'));
  expect(screen.getByRole('region', { name: 'Aufgabe prüfen' })).toBeInTheDocument();
  view.rerender(<MailFollowupAction result={{ ...result, id: 'other' }} />);
  expect(screen.queryByRole('region', { name: 'Aufgabe prüfen' })).not.toBeInTheDocument();
});

test('a draft requires explicit request and carries optional human instructions', () => {
  render(<MailDraftRequest result={result} />);
  expect(mockDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Antwort entwerfen'));
  expect(mockDraft).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Zusätzliche Angaben für die Antwort (optional)'), {
    target: { value: 'Donnerstag bestätigen, Preis offen lassen.' },
  });
  fireEvent.click(screen.getByText('Entwurf erstellen'));
  expect(mockDraft).toHaveBeenCalledWith({
    id: result.id,
    revision: result.revision,
    instructions: 'Donnerstag bestätigen, Preis offen lassen.',
    requestId: '00000000-0000-4000-8000-000000000001',
  });
});

test('existing draft is opened explicitly and never regenerated', () => {
  render(
    <MailDraftRequest
      result={{ ...result, draftStatus: 'created' }}
      content={{
        resultId: result.id,
        mailbox: 'owner@example.test',
        message: { subject: '', sender: '', receivedAt: '', body: '', bodyTruncated: false },
        draft: {
          subject: 'RE: Wartung',
          body: 'Vorschlag',
          bodyTruncated: false,
          url: 'https://outlook.office.com/mail/deeplink/compose/example',
        },
      }}
    />,
  );
  expect(screen.queryByText('Antwort entwerfen')).not.toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Entwurf in Outlook öffnen' });
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(mockDraft).not.toHaveBeenCalled();
});

test('editing blocks draft creation and changing mail clears instruction text', () => {
  const view = render(<MailDraftRequest result={result} editing />);
  expect(screen.getByText('Antwort entwerfen').closest('button')).toBeDisabled();
  view.rerender(<MailDraftRequest result={result} />);
  fireEvent.click(screen.getByText('Antwort entwerfen'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Private Angaben' } });
  view.rerender(<MailDraftRequest result={{ ...result, id: 'other' }} />);
  fireEvent.click(screen.getByText('Antwort entwerfen'));
  expect(screen.getByRole('textbox')).toHaveValue('');
});

test('attachments load metadata only after expanding and filenames remain text', () => {
  const view = render(<MailAttachments result={result} />);
  expect(mockAttachments).toHaveBeenLastCalledWith(result.id, result.revision, false);
  const details = view.container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(mockAttachments).toHaveBeenLastCalledWith(result.id, result.revision, true);
  mockAttachments.mockReturnValue({
    data: {
      attachments: [
        {
          id: 'attachment',
          name: '<img src=x onerror=alert(1)>.exe',
          contentType: 'application/octet-stream',
          size: 1024,
          isInline: false,
        },
      ],
      hasMore: false,
    },
  });
  view.rerender(<MailAttachments result={result} />);
  expect(screen.getByText('<img src=x onerror=alert(1)>.exe')).toBeInTheDocument();
  expect(view.container.querySelector('img,iframe,object,a')).toBeNull();
});

test.each([
  'javascript:alert(1)',
  'https://outlook.office.com.evil.test/mail/x',
  'https://attacker@outlook.office.com/mail/x',
  'https://erp.rzcloud.ch.evil.test/web#id=1',
  'http://outlook.office.com/mail/x',
])('rejects unsafe external task/draft link %s', (url) => {
  expect(safeOutlookDraftUrl(url)).toBeUndefined();
  expect(safeOdooTaskUrl(url)).toBeUndefined();
});
