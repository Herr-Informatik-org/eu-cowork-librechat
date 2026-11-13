import { render, screen } from '@testing-library/react';
import DictationPreview from '../DictationPreview';
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
it('keeps typed text separate from the provisional preview and labels finalization', () => {
  render(
    <DictationPreview
      existingText="Bitte prüfen:"
      status={{ active: false, processing: true, text: 'Eine vorläufige Notiz.', delayed: false }}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Bitte prüfen: Eine vorläufige Notiz.');
  expect(screen.getByText('Eine vorläufige Notiz.')).toHaveClass('italic');
  expect(screen.getByText('com_ui_dictation_finalizing')).toBeVisible();
});
