import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import { MailChat, MailCorrespondence, emptyMailChat } from '../Chat';
import type { MailChatState } from '../Chat';

const mockChat = jest.fn();
let mockLoading = false;
const mockCorrespondence = jest.fn();
const mockOpen = jest.fn();
const mockApply = jest.fn();
const mockNext = jest.fn();
const result: MailWorkspaceResult = {
  id: 'mail',
  revision: 'revision',
  subject: 'Termin',
  sender: 'kunde@example.test',
  receivedAt: '2026-10-27T08:00:00Z',
  priority: 'normal',
  action: 'reply',
  summary: 'Termin abstimmen',
  reason: 'Rückfrage',
  questions: [],
  draftStatus: 'created',
};
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: keyof typeof mockTranslations, options: Record<string, string | number> = {}) =>
      Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
jest.mock('../Followup', () => ({
  mailActionError: (_error: Error, fallback: string) => fallback,
}));
jest.mock('~/data-provider/Mail', () => ({
  useMailChat: () => ({ mutateAsync: mockChat, isLoading: mockLoading }),
  useMailCorrespondence: (id: string, search: string, enabled: boolean) => {
    mockCorrespondence(id, search, enabled);
    return { data: { pages: [{ results: [result] }] }, hasNextPage: true, fetchNextPage: mockNext };
  },
}));
function Harness({ initial = emptyMailChat() }: { initial?: MailChatState }) {
  const [state, setState] = useState(initial);
  return (
    <MailChat
      result={result}
      draft="Meine vorhandene Antwort"
      state={state}
      onChange={setState}
      onOpen={mockOpen}
      onApply={mockApply}
    />
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  mockLoading = false;
  mockChat.mockResolvedValue({ answer: 'Das Zeitfenster ist offen.', sources: [result] });
});

it('sends explicit questions with current revision and draft; correspondence requires opt-in', async () => {
  render(<Harness />);
  expect(mockChat).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Welcher Termin ist offen?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  await screen.findByText('Das Zeitfenster ist offen.');
  expect(mockChat).toHaveBeenCalledWith({
    revision: 'revision',
    message: 'Welcher Termin ist offen?',
    history: [],
    draft: 'Meine vorhandene Antwort',
    includeCorrespondence: false,
  });
  expect(mockApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Was steht in weiteren Mails?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
  expect(mockChat.mock.calls[1][0]).toEqual(
    expect.objectContaining({
      includeCorrespondence: true,
      history: [
        { role: 'user', content: 'Welcher Termin ist offen?' },
        { role: 'assistant', content: 'Das Zeitfenster ist offen.' },
      ],
    }),
  );
});
it('renders model output as inert text and opens source metadata only on click', () => {
  const attack =
    '<img src="https://example.test/tracker" onerror="alert(1)"><script>attack()</script>';
  render(
    <Harness
      initial={{
        ...emptyMailChat(),
        messages: [{ role: 'assistant', content: attack, sources: [result] }],
      }}
    />,
  );
  expect(screen.getByText(attack)).toBeInTheDocument();
  expect(document.querySelector('img, script')).toBeNull();
  expect(mockOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Verwendete Mails'));
  fireEvent.click(screen.getByRole('button', { name: 'Termin' }));
  expect(mockOpen).toHaveBeenCalledWith(result);
});
it('requires confirmation before placing a chat response in the local editor', () => {
  render(
    <Harness
      initial={{
        ...emptyMailChat(),
        messages: [{ role: 'assistant', content: 'Überarbeiteter Text' }],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Als Antwort im Editor übernehmen' }));
  const dialog = screen.getByRole('alertdialog');
  expect(mockApply).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Als Antwort im Editor übernehmen' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Als Antwort im Editor übernehmen',
    }),
  );
  expect(mockApply).toHaveBeenCalledWith('Überarbeiteter Text');
  expect(mockChat).not.toHaveBeenCalled();
});
it('preserves the question on failure and does not retry automatically', async () => {
  mockChat.mockRejectedValue(new Error('private backend detail'));
  render(<Harness />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Termin klären' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent('private backend detail');
  expect(screen.getByRole('textbox')).toHaveValue('Termin klären');
  expect(mockChat).toHaveBeenCalledTimes(1);
});
it('loads correspondence only after opening the section and keeps search/paging explicit', async () => {
  render(<MailCorrespondence result={result} onOpen={mockOpen} />);
  expect(mockCorrespondence).toHaveBeenLastCalledWith('mail', '', false);
  fireEvent.click(screen.getByText('Weitere Mails dieses Kontakts'));
  await waitFor(() => expect(mockCorrespondence).toHaveBeenLastCalledWith('mail', '', true));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wartung' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(mockCorrespondence).toHaveBeenLastCalledWith('mail', 'Wartung', true);
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Mails laden' }));
  expect(mockNext).toHaveBeenCalledTimes(1);
});

it('keeps a long answer fully visible while bounding it for the next question', async () => {
  const answer = `Ausführliche Antwort ${'A'.repeat(9000)}`;
  mockChat.mockResolvedValueOnce({ answer, sources: [] });
  render(<Harness />);
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Bitte ausführlich erklären' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  expect(await screen.findByText(answer)).toBeVisible();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bitte kürzer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
  expect(mockChat.mock.calls[1][0].history[1]).toEqual({
    role: 'assistant',
    content: answer.slice(0, 4000),
  });
  expect(JSON.stringify(mockChat.mock.calls[1][0]).length).toBeLessThanOrEqual(24000);
  expect(screen.getByText(answer)).toBeVisible();
});

it('retains the question and skips the request if its serialized payload cannot fit', async () => {
  const input = '\u0000'.repeat(4000);
  render(<Harness initial={{ ...emptyMailChat(), input }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByRole('textbox')).toHaveValue(input);
  expect(mockChat).not.toHaveBeenCalled();
});

it.each([{ ctrlKey: true }, { metaKey: true }])(
  'asks the same explicit chat question using Enter with %j',
  async (modifier) => {
    render(<Harness />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    expect(input).toHaveAccessibleDescription(
      'Strg/Cmd + Enter: Frage abschicken · Enter: neue Zeile',
    );
    fireEvent.change(input, { target: { value: 'Welche Rückfrage ist noch offen?' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', ...modifier })).toBe(false);
    await screen.findByText('Das Zeitfenster ist offen.');
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledWith({
      revision: 'revision',
      message: 'Welche Rückfrage ist noch offen?',
      history: [],
      draft: 'Meine vorhandene Antwort',
      includeCorrespondence: false,
    });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  },
);

it.each([
  {},
  { shiftKey: true },
  { ctrlKey: true, shiftKey: true },
  { ctrlKey: true, altKey: true },
  { ctrlKey: true, isComposing: true },
  { ctrlKey: true, repeat: true },
])('does not submit plain Enter, composition or unsupported key combinations %j', (options) => {
  render(<Harness initial={{ ...emptyMailChat(), input: 'Zeile eins' }} />);
  const input = screen.getByRole('textbox');
  expect(fireEvent.keyDown(input, { key: 'Enter', ...options })).toBe(true);
  expect(mockChat).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

it.each(['empty', 'pending', 'loading'] as const)(
  'blocks the chat keyboard action when %s',
  (mode) => {
    mockLoading = mode === 'loading';
    render(
      <Harness
        initial={{
          ...emptyMailChat(),
          input: mode === 'empty' ? '  ' : 'Frage',
          pending: mode === 'pending',
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Fragen' })).toBeDisabled();
    expect(mockChat).not.toHaveBeenCalled();
  },
);

it('suppresses repeated shortcuts and button clicks during the same question', async () => {
  let resolve!: (value: { answer: string }) => void;
  mockChat.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<Harness initial={{ ...emptyMailChat(), input: 'Offene Frage' }} />);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  fireEvent.click(screen.getByRole('button', { name: 'Fragen' }));
  expect(mockChat).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ answer: 'Antwort' }));
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(mockApply).not.toHaveBeenCalled();
});
