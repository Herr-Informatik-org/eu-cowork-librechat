import {
  graphRecipients,
  replyAllRecipients,
  recipientFingerprint,
  draftRecipientFingerprint,
} from './recipients';

const recipient = (address: string, name = '') => ({ address, name });
const graphRecipient = (address: string) => ({ emailAddress: { address } });

describe('native reply-all recipient boundaries', () => {
  test('keeps distinct To and Cc, removes own mail and UPN, and deduplicates case-insensitively', () => {
    expect(
      replyAllRecipients(
        {
          sender: 'sender@example.invalid',
          senderName: 'Sender',
          toRecipients: [recipient('self@example.invalid'), recipient('peer@example.invalid')],
          ccRecipients: [
            recipient('SELF-UPN@example.invalid'),
            recipient('PEER@example.invalid'),
            recipient('copy@example.invalid'),
          ],
        },
        ['SELF@example.invalid', 'self-upn@example.invalid'],
      ),
    ).toEqual({
      to: [recipient('sender@example.invalid', 'Sender'), recipient('peer@example.invalid')],
      cc: [recipient('copy@example.invalid')],
    });
  });
  test('uses multiple Reply-To targets without introducing the original sender', () => {
    const recipients = replyAllRecipients(
      {
        sender: 'envelope@example.invalid',
        replyTo: [recipient('support@example.invalid'), recipient('support2@example.invalid')],
        toRecipients: [recipient('peer@example.invalid')],
        ccRecipients: [recipient('support@example.invalid')],
      },
      [],
    );
    expect(recipients.to.map((item) => item.address)).toEqual([
      'support@example.invalid',
      'support2@example.invalid',
      'peer@example.invalid',
    ]);
    expect(recipients.cc).toEqual([]);
  });
  test.each([
    {},
    [{ emailAddress: { address: 'bad\r\nBcc:evil@example.invalid' } }],
    [{ emailAddress: { address: 'peer@example.invalid', name: 'bad\nname' } }],
    [{ emailAddress: { address: 'peer@example.invalid', name: {} } }],
    [{ emailAddress: { address: 'javascript:alert(1)' } }],
    Array.from({ length: 501 }, () => graphRecipient('peer@example.invalid')),
  ])('rejects malformed or unbounded Graph recipient metadata', (value) => {
    expect(() => graphRecipients(value)).toThrow();
  });
  test('comparison allows address casing and display-name normalization, but never Cc promotion', () => {
    const original = recipientFingerprint({
      to: [recipient('peer@example.invalid')],
      cc: [recipient('copy@example.invalid')],
    });
    expect(
      draftRecipientFingerprint({
        toRecipients: [graphRecipient('PEER@example.invalid')],
        ccRecipients: [graphRecipient('COPY@example.invalid')],
        bccRecipients: [],
      }),
    ).toBe(original);
    expect(
      draftRecipientFingerprint({
        toRecipients: [
          graphRecipient('peer@example.invalid'),
          graphRecipient('copy@example.invalid'),
        ],
        ccRecipients: [],
      }),
    ).not.toBe(original);
  });
});
