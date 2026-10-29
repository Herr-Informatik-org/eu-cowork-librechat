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
let mockDraftLoading = false;
let mockDraftOutcome: { status: string; draftUrl?: string } | undefined;
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
  useMailDraftRequest: () => ({
    mutate: mockDraft,
    isLoading: mockDraftLoading,
    data: mockDraftOutcome,
  }),
  useMailAttachments: (...args: Parameters<typeof mockAttachments>) => mockAttachments(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockDraftLoading = false;
  mockDraftOutcome = undefined;
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
  expect(mockDraft).toHaveBeenCalledWith(
    {
      id: result.id,
      revision: result.revision,
      instructions: 'Donnerstag bestätigen, Preis offen lassen.',
      requestId: '00000000-0000-4000-8000-000000000001',
    },
    expect.objectContaining({ onSettled: expect.any(Function) }),
  );
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

test('R opens a manual draft form without generating and preserves instructions across refresh', () => {
  const view = render(<MailDraftRequest result={result} openRequest={1} />);
  const input = screen.getByRole('textbox');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'Meine eigene ausführliche Antwortvorgabe' } });
  view.rerender(<MailDraftRequest result={{ ...result, revision: 'refreshed' }} openRequest={1} />);
  expect(screen.getByRole('textbox')).toHaveValue('Meine eigene ausführliche Antwortvorgabe');
  expect(mockDraft).not.toHaveBeenCalled();
});

test('shows actual reply recipients as inert text before the draft request', () => {
  render(
    <MailDraftRequest
      result={result}
      openRequest={1}
      content={{
        resultId: result.id,
        mailbox: 'owner@example.test',
        message: {
          subject: '',
          sender: 'sender@example.test',
          receivedAt: '',
          body: '',
          bodyTruncated: false,
          replyRecipients: [
            { name: '<img src=x onerror=alert(1)>', address: 'reply@example.test' },
          ],
        },
      }}
    />,
  );
  expect(screen.getByText(/<img src=x onerror=alert\(1\)> <reply@example.test>/)).toBeVisible();
  expect(document.querySelector('img')).toBeNull();
  expect(mockDraft).not.toHaveBeenCalled();
});

test.each(['ctrlKey', 'metaKey'])(
  'submits a draft request once with %s + Enter and permits empty optional instructions',
  (modifier) => {
    render(<MailDraftRequest result={result} openRequest={1} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true });
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf erstellen' }));
    expect(mockDraft).toHaveBeenCalledTimes(1);
    expect(mockDraft.mock.calls[0][0]).toMatchObject({
      id: result.id,
      revision: result.revision,
      instructions: '',
    });
  },
);

test.each([
  { key: 'Enter' },
  { key: 'Enter', ctrlKey: true, shiftKey: true },
  { key: 'Enter', ctrlKey: true, altKey: true },
  { key: 'Enter', ctrlKey: true, repeat: true },
  { key: 'Enter', ctrlKey: true, isComposing: true },
  { key: 'Enter', ctrlKey: true, keyCode: 229 },
])('keeps draft text input unchanged without an explicit submit chord: %j', (keys) => {
  render(<MailDraftRequest result={result} openRequest={1} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Freitag bestätigen.\nBitte Rückfrage ergänzen.' } });
  expect(fireEvent.keyDown(input, keys)).toBe(true);
  expect(mockDraft).not.toHaveBeenCalled();
  expect(input).toHaveValue('Freitag bestätigen.\nBitte Rückfrage ergänzen.');
});

test('draft shortcut uses current instructions and revision, retries only after settled, and respects busy editing', () => {
  const view = render(<MailDraftRequest result={result} openRequest={1} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Nur den Termin bestätigen.' } });
  view.rerender(
    <MailDraftRequest result={{ ...result, revision: 'new-revision' }} openRequest={1} />,
  );
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mockDraft.mock.calls[0][0]).toMatchObject({
    revision: 'new-revision',
    instructions: 'Nur den Termin bestätigen.',
  });
  mockDraft.mock.calls[0][1].onSettled();
  mockDraftLoading = true;
  view.rerender(<MailDraftRequest result={result} openRequest={1} />);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).toHaveBeenCalledTimes(1);
  mockDraftLoading = false;
  view.rerender(<MailDraftRequest result={result} openRequest={1} editing />);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).toHaveBeenCalledTimes(1);
  view.rerender(<MailDraftRequest result={result} openRequest={1} />);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).toHaveBeenCalledTimes(2);
});

test('Escape closes the manual draft form, restores focus and retains optional notes', () => {
  const view = render(<MailDraftRequest result={result} openRequest={1} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Angaben behalten' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Antwort entwerfen' })).toHaveFocus();
  view.rerender(<MailDraftRequest result={result} openRequest={2} />);
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(screen.getByRole('textbox')).toHaveValue('Angaben behalten');
  expect(mockDraft).not.toHaveBeenCalled();
});

test('shows reply-all To and Cc as plain text without generating a draft', () => {
  render(
    <MailDraftRequest
      result={result}
      openRequest={1}
      content={{
        resultId: result.id,
        mailbox: 'owner@example.test',
        message: {
          subject: '',
          sender: 'sender@example.test',
          receivedAt: '',
          body: '',
          bodyTruncated: false,
          replyMode: 'all',
          replyRecipients: [{ name: 'Kunde', address: 'customer@example.test' }],
          replyCcRecipients: [{ name: '<script>cc</script>', address: 'copy@example.test' }],
        },
      }}
    />,
  );
  expect(screen.getByText('Antwort an alle · An')).toBeVisible();
  expect(screen.getByText('Cc')).toBeVisible();
  expect(screen.getByText(/<script>cc<\/script> <copy@example.test>/)).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
  expect(mockDraft).not.toHaveBeenCalled();
});

test('focuses the completed Outlook draft link only if the request still owns focus', () => {
  const view = render(<MailDraftRequest result={result} openRequest={1} />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  mockDraftOutcome = {
    status: 'created',
    draftUrl: 'https://outlook.office.com/mail/deeplink/compose/created-draft',
  };
  view.rerender(<MailDraftRequest result={result} openRequest={1} />);
  expect(screen.getByRole('link', { name: 'Entwurf in Outlook öffnen' })).toHaveFocus();
});

test('does not create a draft through shortcut while permission or content is unavailable', () => {
  const view = render(<MailDraftRequest result={result} openRequest={1} />);
  const input = screen.getByRole('textbox');
  view.rerender(<MailDraftRequest result={result} openRequest={1} disabled />);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Entwurf erstellen' })).toBeDisabled();
});

test('new reply explicitly bypasses an existing-draft UI barrier without editing or removing the previous draft', () => {
  render(<MailDraftRequest result={{ ...result, draftStatus: 'stale' }} />);
  expect(mockDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Neue Antwort erstellen' }));
  expect(screen.getByText(/Bestehende Entwürfe bleiben erhalten/)).toBeInTheDocument();
  const textbox = screen.getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'Bitte neuen Liefertermin nennen.' } });
  fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).toHaveBeenCalledTimes(1);
  expect(mockDraft.mock.calls[0][0]).toMatchObject({
    id: result.id,
    revision: result.revision,
    newReply: true,
    instructions: 'Bitte neuen Liefertermin nennen.',
  });
});

test('uncertain draft state never offers or triggers an additional new reply', () => {
  const { container } = render(
    <MailDraftRequest result={{ ...result, draftStatus: 'uncertain' }} openRequest={1} />,
  );
  expect(screen.queryByRole('button', { name: 'Neue Antwort erstellen' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.keyDown(container, { key: 'Enter', ctrlKey: true });
  expect(mockDraft).not.toHaveBeenCalled();
});

test('explicit research transfer fills the form once but never generates a draft automatically', () => {
  const request = { id: 1, text: 'Recherche: Lizenzposition prüfen.' };
  const view = render(<MailDraftRequest result={result} instructionRequest={request} />);
  expect(screen.getByRole('textbox')).toHaveValue(request.text);
  expect(mockDraft).not.toHaveBeenCalled();
  view.rerender(<MailDraftRequest result={result} instructionRequest={request} />);
  expect(screen.getByRole('textbox')).toHaveValue(request.text);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
  expect(mockDraft.mock.calls[0][0]).toMatchObject({ instructions: request.text });
  expect(mockDraft.mock.calls[0][0]).not.toHaveProperty('newReply');
});
