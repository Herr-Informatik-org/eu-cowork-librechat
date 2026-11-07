import type { MailMessage, MailRecipient } from './types';
import { MailGraphError } from './errors';

const recipientLimit = 500;
const addressKey = (address: string) => address.trim().toLowerCase();

/** Graph recipient fields are mailbox data, never model- or client-supplied destinations. */
export function graphRecipients(value: unknown): MailRecipient[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > recipientLimit) throw new MailGraphError(502);
  return value.map((item) => {
    const address = item?.emailAddress?.address;
    const name = item?.emailAddress?.name ?? '';
    if (
      typeof address !== 'string' ||
      address.length > 320 ||
      !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(address) ||
      typeof name !== 'string' ||
      name.length > 320 ||
      // eslint-disable-next-line no-control-regex -- Reject malformed mailbox metadata.
      /[\u0000-\u001f\u007f]/.test(address + name)
    )
      throw new MailGraphError(502);
    return { name, address };
  });
}

export function replyAllRecipients(
  message: Pick<MailMessage, 'sender' | 'senderName' | 'replyTo' | 'toRecipients' | 'ccRecipients'>,
  selfAddresses: readonly string[],
): { to: MailRecipient[]; cc: MailRecipient[] } {
  const seen = new Set(selfAddresses.map(addressKey).filter(Boolean));
  const unique = (recipients: MailRecipient[]) =>
    recipients.filter((recipient) => {
      const key = addressKey(recipient.address);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const targets = message.replyTo?.length
    ? message.replyTo
    : [{ name: message.senderName ?? '', address: message.sender }];
  return {
    to: unique([...targets, ...(message.toRecipients ?? [])]),
    cc: unique(message.ccRecipients ?? []),
  };
}

export function recipientFingerprint(recipients: { to: MailRecipient[]; cc: MailRecipient[] }) {
  return JSON.stringify([
    recipients.to.map((recipient) => addressKey(recipient.address)).sort(),
    recipients.cc.map((recipient) => addressKey(recipient.address)).sort(),
  ]);
}

/** Native reply-all remains authoritative; unexpected targets stop all content publication. */
export function draftRecipientFingerprint(value: Record<string, unknown>): string {
  const to = graphRecipients(value.toRecipients);
  const cc = graphRecipients(value.ccRecipients);
  const bcc = graphRecipients(value.bccRecipients);
  const addresses = [...to, ...cc].map((recipient) => addressKey(recipient.address));
  if (!addresses.length || bcc.length || new Set(addresses).size !== addresses.length)
    throw new MailGraphError(502);
  return recipientFingerprint({ to, cc });
}
