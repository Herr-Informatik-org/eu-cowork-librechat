import { render, screen } from '@testing-library/react';
import PdfIntakeNotice from '../PdfIntakeNotice';
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
describe('local PDF reading notices', () => {
  it.each(['read', 'ocr', 'incomplete', 'skipped'] as const)(
    'shows %s independently of model output',
    (status) => {
      render(<PdfIntakeNotice file={{ metadata: { documentIntake: { status } } }} />);
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_pdf_intake_' + status);
    },
  );
  it('does not invent an outcome before processing', () => {
    const { container } = render(<PdfIntakeNotice file={{ filename: 'Konto.pdf' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
