import { fireEvent, render, screen } from '@testing-library/react';
import type { MailWorkspaceContent } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import MailRecipients from '../Recipients';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: keyof typeof mockTranslations, options: Record<string, string | number> = {}) =>
      Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        mockTranslations[key] || key,
      ),
}));
const message: MailWorkspaceContent['message'] = {
  sender: 'sender@example.test',
  senderName: 'Testperson',
  subject: 'Subject',
  receivedAt: '2026-10-29T08:00:00.000Z',
  body: '',
  bodyTruncated: false,
  toRecipients: [{ name: 'Original To', address: 'to@example.test' }],
  ccRecipients: [],
};

test('always shows Cc and distinguishes a known empty list from loading or missing data', () => {
  const view = render(<MailRecipients sender="sender@example.test" loading />);
  expect(screen.getByText('Cc:')).toBeInTheDocument();
  expect(screen.getAllByText('Lädt …')).toHaveLength(2);
  expect(screen.queryByText('Keine')).not.toBeInTheDocument();
  view.rerender(<MailRecipients message={message} sender="sender@example.test" loading={false} />);
  expect(screen.getByText('Keine')).toBeInTheDocument();
  expect(screen.getByText('Testperson <sender@example.test>')).toBeInTheDocument();
  expect(screen.getByText('Original To <to@example.test>')).toBeInTheDocument();
  view.rerender(
    <MailRecipients
      message={{ ...message, ccRecipients: undefined }}
      sender="sender@example.test"
      loading={false}
    />,
  );
  expect(screen.queryByText('Keine')).not.toBeInTheDocument();
  expect(screen.getByText('Nicht verfügbar')).toBeInTheDocument();
});

test('long recipient lists remain compact and all addresses are available through keyboard-focusable details', () => {
  const recipients = Array.from({ length: 4 }, (_, index) => ({
    name: `Person ${index}`,
    address: `person${index}@example.test`,
  }));
  const view = render(
    <MailRecipients
      message={{ ...message, ccRecipients: recipients }}
      sender={message.sender}
      loading={false}
    />,
  );
  const details = view.container.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  expect(summary).toHaveTextContent('Person 0 <person0@example.test>');
  expect(summary).toHaveTextContent('2 weitere');
  expect(details.open).toBe(false);
  summary.focus();
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByText('Person 3 <person3@example.test>')).toBeVisible();
});

test('recipient names remain escaped text and additional fields such as Bcc are never rendered', () => {
  const original = {
    ...message,
    senderName: '<img src=x onerror=alert(1)>',
    bccRecipients: [{ name: 'Private Bcc', address: 'hidden@example.test' }],
  };
  const view = render(
    <MailRecipients message={original} sender={message.sender} loading={false} />,
  );
  expect(
    screen.getByText('<img src=x onerror=alert(1)> <sender@example.test>'),
  ).toBeInTheDocument();
  expect(view.container.querySelector('img,a,iframe')).toBeNull();
  expect(screen.queryByText(/Private Bcc|hidden@example.test/)).not.toBeInTheDocument();
});
