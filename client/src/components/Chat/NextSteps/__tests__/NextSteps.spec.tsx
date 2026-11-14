import { render, screen, fireEvent } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { planInsertion, insertIntoComposer, nextStepLabel } from '../insert';
import NextSteps, { canShowNextSteps } from '../NextSteps';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const answer = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'resp',
    conversationId: 'convo',
    parentMessageId: 'user',
    isCreatedByUser: false,
    text: '',
    content: [{ type: 'text', text: 'Fertig.' }],
    nextSteps: [
      { text: 'Fasse das Protokoll zusammen' },
      { text: 'Schreibe Frau Meier:', needsInput: true },
    ],
    ...overrides,
  }) as TMessage;

function mountComposer(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.id = 'prompt-textarea';
  textarea.value = value;
  document.body.appendChild(textarea);
  return textarea;
}

beforeEach(() => {
  document.body.innerHTML = '';
  /** jsdom lacks `execCommand`; the util falls back to a value write and warns. */
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  Object.defineProperty(document, 'queryCommandSupported', {
    configurable: true,
    value: () => false,
  });
});

describe('planInsertion', () => {
  it('fills an empty draft and appends to an existing one on its own line', () => {
    expect(planInsertion('', { text: 'Fasse zusammen' })).toEqual({
      text: 'Fasse zusammen',
      replace: true,
    });
    expect(planInsertion('  \n', { text: 'Fasse zusammen' }).replace).toBe(true);
    expect(planInsertion('Mein Entwurf', { text: 'Fasse zusammen' })).toEqual({
      text: '\nFasse zusammen',
      replace: false,
    });
    expect(planInsertion('Mein Entwurf\n', { text: 'Fasse zusammen' }).text).toBe('Fasse zusammen');
  });

  it('leaves room to type after an open step and never adds a suggestion twice', () => {
    expect(planInsertion('', { text: 'Schreibe Frau Meier:', needsInput: true }).text).toBe(
      'Schreibe Frau Meier: ',
    );
    expect(planInsertion('Entwurf\nFasse zusammen', { text: 'Fasse zusammen' }).text).toBe('');
  });

  it('labels open steps with an ellipsis', () => {
    expect(nextStepLabel({ text: 'Schreibe Frau Meier:', needsInput: true })).toBe(
      'Schreibe Frau Meier: …',
    );
  });
});

describe('insertIntoComposer', () => {
  it('keeps the draft, appends the suggestion and puts the cursor at the end', () => {
    const textarea = mountComposer('Mein Entwurf');
    expect(insertIntoComposer({ text: 'Fasse das zusammen' })).toBe(true);
    expect(textarea.value).toBe('Mein Entwurf\nFasse das zusammen');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(document.activeElement).toBe(textarea);
  });

  it('does nothing without an enabled composer', () => {
    expect(insertIntoComposer({ text: 'Fasse das zusammen' })).toBe(false);
    const textarea = mountComposer('');
    textarea.disabled = true;
    expect(insertIntoComposer({ text: 'Fasse das zusammen' })).toBe(false);
  });
});

describe('NextSteps', () => {
  it('renders the chips as a labelled group and loads a click into the composer', () => {
    const textarea = mountComposer('');
    render(<NextSteps message={answer()} isSubmitting={false} />);
    expect(screen.getByRole('group', { name: 'com_ui_next_steps' })).toBeInTheDocument();
    const open = screen.getByRole('button', { name: /Schreibe Frau Meier: …/ });
    expect(open).toHaveTextContent('com_ui_next_step_needs_input');
    fireEvent.click(open);
    expect(textarea.value).toBe('Schreibe Frau Meier: ');
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_next_step_inserted');
  });

  it('stays hidden while running, after an error, without steps or next to an open question', () => {
    const question = {
      type: 'ask_user_question',
      ask_user_question: { actionId: 'a1', question: { question: 'Word oder Excel?' } },
    };
    expect(canShowNextSteps(answer(), true)).toBe(false);
    expect(canShowNextSteps(answer({ unfinished: true }), false)).toBe(false);
    expect(canShowNextSteps(answer({ error: true }), false)).toBe(false);
    expect(canShowNextSteps(answer({ nextSteps: [] }), false)).toBe(false);
    expect(canShowNextSteps(answer({ isCreatedByUser: true }), false)).toBe(false);
    expect(
      canShowNextSteps(answer({ content: [question] as unknown as TMessage['content'] }), false),
    ).toBe(false);
    expect(canShowNextSteps(answer(), false)).toBe(true);
    const { container } = render(<NextSteps message={answer()} isSubmitting />);
    expect(container).toBeEmptyDOMElement();
  });
});

it('keeps reply drafts out of the next-step chips', () => {
  const reply = { text: 'Ja, beginne bitte mit AarPower AG.', kind: 'reply' as const };
  expect(canShowNextSteps(answer({ nextSteps: [reply] }), false)).toBe(false);
  render(
    <NextSteps
      message={answer({ nextSteps: [reply, { text: 'Fasse zusammen' }] })}
      isSubmitting={false}
    />,
  );
  expect(screen.getByRole('button', { name: 'Fasse zusammen' })).toBeInTheDocument();
  expect(screen.queryByText(reply.text)).not.toBeInTheDocument();
});
