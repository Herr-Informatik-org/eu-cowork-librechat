import React from 'react';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { projectReplyDraft, questionReplyDraft } from './reply';
import useReplySuggestion from './useReplySuggestion';
import ReplySuggestion from './ReplySuggestion';

let mockMessage: TMessage | null = null;
jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessageSelect: (_index: number, project: typeof projectReplyDraft) =>
    project(mockMessage),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const answer = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'reply-1',
    conversationId: 'chat-1',
    parentMessageId: 'user-1',
    isCreatedByUser: false,
    text: 'Soll ich mit AarPower AG beginnen?',
    nextSteps: [{ text: 'Ja, beginne bitte mit AarPower AG.', kind: 'reply' }],
    ...overrides,
  }) as TMessage;

const question = {
  active: true,
  locked: false,
  multiSelect: false,
  liveAsk: { actionId: 'ask-1' },
  selected: null,
  options: [{ label: 'Mit AarPower beginnen (empfohlen)', value: 'Beginne mit AarPower AG' }],
};

beforeEach(() => {
  mockMessage = answer();
  Object.defineProperty(document, 'queryCommandSupported', {
    configurable: true,
    value: () => false,
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

it('only projects explicit reply metadata on a completed assistant question', () => {
  expect(projectReplyDraft(answer())?.text).toBe('Ja, beginne bitte mit AarPower AG.');
  for (const fields of [
    { error: true },
    { unfinished: true },
    { isCreatedByUser: true },
    { text: 'Die Arbeit ist fertig.' },
    { nextSteps: [{ text: 'Fasse zusammen' }] },
  ]) {
    expect(projectReplyDraft(answer(fields))).toBeNull();
  }
  expect(
    projectReplyDraft(
      answer({
        text: '',
        content: [{ type: ContentTypes.TEXT, text: 'Soll ich **beginnen?**' }],
        nextSteps: [{ text: 'Der Termin ist', kind: 'reply', needsInput: true }],
      }),
    )?.text,
  ).toBe('Der Termin ist …');
});

it('uses an explicit or recommended native choice, never invents one', () => {
  expect(questionReplyDraft(question)?.scope).toBe('ask-1');
  expect(questionReplyDraft({ ...question, locked: true })).toBeNull();
  expect(questionReplyDraft({ ...question, multiSelect: true })).toBeNull();
  const options = [
    { label: 'Word', value: 'Word' },
    { label: 'PDF', value: 'PDF' },
  ];
  expect(questionReplyDraft({ ...question, options })).toBeNull();
  expect(questionReplyDraft({ ...question, options, selected: 1 })?.text).toBe('PDF');
});

function Harness({
  conversationId = 'chat-1',
  blocked = false,
}: {
  conversationId?: string;
  blocked?: boolean;
}) {
  const [text, setText] = React.useState('');
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const draft = useReplySuggestion({
    index: 0,
    conversationId,
    text,
    blocked,
    questionActive: false,
    questionDraft: null,
    textAreaRef: ref,
  });
  return (
    <form onSubmit={(event) => event.preventDefault()} data-testid="form">
      {draft.suggestion && (
        <ReplySuggestion
          text={draft.suggestion}
          descriptionId="reply-hint"
          onAccept={draft.accept}
        />
      )}
      <textarea
        ref={ref}
        value={text}
        aria-label="composer"
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={draft.handleKeyDown}
        onCompositionStart={draft.onCompositionStart}
        onCompositionEnd={draft.onCompositionEnd}
      />
    </form>
  );
}

it('shows grey text without filling or sending; Tab accepts, Enter remains a separate action', () => {
  render(<Harness />);
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  const send = jest.fn();
  screen.getByTestId('form').addEventListener('submit', send);
  expect(screen.getByTestId('reply-suggestion')).toBeInTheDocument();
  expect(textarea.value).toBe('');
  expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true);
  expect(textarea.value).toBe('');
  expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
  expect(textarea.value).toBe('Ja, beginne bitte mit AarPower AG.');
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(true);
});

it('keeps Shift-Tab, modified Tab and IME composition intact; Escape dismisses', () => {
  render(<Harness />);
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  for (const modifier of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    expect(fireEvent.keyDown(textarea, { key: 'Tab', ...modifier })).toBe(true);
    expect(textarea.value).toBe('');
  }
  expect(fireEvent.keyDown(textarea, { key: 'Escape' })).toBe(false);
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
});

it('preserves typed drafts and hides while dictating, streaming or disabled', () => {
  const view = render(<Harness blocked />);
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
  view.rerender(<Harness />);
  fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Mein eigener Text' } });
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
  expect(screen.getByRole('textbox')).toHaveValue('Mein eigener Text');
});

it('accepts through the touch button without submitting and never reappears on undo', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_reply_suggestion_accept' }));
  expect(screen.getByRole('textbox')).toHaveValue('Ja, beginne bitte mit AarPower AG.');
  fireEvent.input(screen.getByRole('textbox'), { target: { value: '' } });
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
});

it('changes scope with the active branch and conversation, without reusing a dismissed reply', () => {
  const view = render(<Harness />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
  mockMessage = answer({ messageId: 'reply-2' });
  view.rerender(<Harness />);
  expect(screen.getByTestId('reply-suggestion')).toBeInTheDocument();
  view.rerender(<Harness conversationId="chat-2" />);
  expect(screen.queryByTestId('reply-suggestion')).not.toBeInTheDocument();
});

it('never falls back to a previous answer while a native question owns the composer', () => {
  const { result } = renderHook(() =>
    useReplySuggestion({
      index: 0,
      conversationId: 'chat-1',
      text: '',
      blocked: false,
      questionActive: true,
      questionDraft: null,
      textAreaRef: { current: null },
    }),
  );
  expect(result.current.suggestion).toBe('');
});

it('tracks composition start even when the browser omits isComposing on Tab', () => {
  render(<Harness />);
  const textarea = screen.getByRole('textbox');
  fireEvent.compositionStart(textarea);
  expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(true);
  expect(textarea).toHaveValue('');
  fireEvent.compositionEnd(textarea);
  expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
});
