import { render, screen } from '@testing-library/react';
import DictationPreview from '../DictationPreview';

it('keeps typed text separate and shows only italic provisional text', () => {
  render(
    <DictationPreview
      existingText="Bitte prüfen:"
      status={{ active: false, processing: true, text: 'Eine vorläufige Notiz.', delayed: true }}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Bitte prüfen: Eine vorläufige Notiz.');
  expect(screen.getByText('Eine vorläufige Notiz.')).toHaveClass('italic');
  expect(screen.getByRole('status').textContent).toBe('Bitte prüfen: Eine vorläufige Notiz.');
});
it('does not substitute waiting or delay status lines for an empty transcript', () => {
  render(
    <DictationPreview
      existingText=""
      status={{ active: true, processing: false, text: '', delayed: true }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('');
});
