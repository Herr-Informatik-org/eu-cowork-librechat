import { fireEvent, render, screen } from '@testing-library/react';
import type { MailWorkspaceResult } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import PersonalRule from '../PersonalRule';

const mockSave = jest.fn();
jest.mock('~/data-provider/Mail', () => ({
  useMailActions: () => ({ rule: { mutate: mockSave, isLoading: false } }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key] || key,
}));
const result = { id: 'mail', revision: 'r1', sender: 'kunde@example.test' } as MailWorkspaceResult;
beforeEach(() => jest.clearAllMocks());

test('requires reviewing and explicitly saving a proposed personal rule', () => {
  render(
    <PersonalRule
      result={result}
      disabled={false}
      proposal={{ text: 'Bei diesem Kontakt kurze Antworten bevorzugen.', scope: 'sender' }}
    />,
  );
  expect(mockSave).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Änderung als persönliche Regel prüfen' }));
  const input = screen.getByRole('textbox', { name: 'Meine persönliche Regel' });
  expect(input).toHaveValue('Bei diesem Kontakt kurze Antworten bevorzugen.');
  expect(mockSave).not.toHaveBeenCalled();
  fireEvent.change(input, {
    target: { value: 'Für diesen Kontakt kurz und freundlich antworten.' },
  });
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_mail_rule_save }));
  expect(mockSave).toHaveBeenCalledWith(
    {
      id: 'mail',
      revision: 'r1',
      scope: 'sender',
      text: 'Für diesen Kontakt kurz und freundlich antworten.',
    },
    expect.any(Object),
  );
});

test('dismissing a one-off correction never creates a personal rule', () => {
  const dismiss = jest.fn();
  render(
    <PersonalRule
      result={result}
      disabled={false}
      proposal={{ text: 'Bei diesem Kontakt kurze Antworten bevorzugen.', scope: 'sender' }}
      onDismissProposal={dismiss}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Nur für diese Mail' }));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(mockSave).not.toHaveBeenCalled();
});
