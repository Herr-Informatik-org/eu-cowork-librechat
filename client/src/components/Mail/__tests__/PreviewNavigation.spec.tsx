import { useRef } from 'react';
import { createHash } from 'crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mailPreviewLink } from 'librechat-data-provider';
import type { MailPreviewLink } from 'librechat-data-provider';
import {
  MAIL_PREVIEW_BRIDGE_SCRIPT,
  MAIL_PREVIEW_BRIDGE_HASH,
  MailPreviewLinkDialog,
  useMailPreviewNavigation,
} from '../PreviewNavigation';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const wrapped =
  'https://che01.safelinks.protection.outlook.com/?url=https%3A%2F%2Ferp.rzcloud.ch%2Fmail%2Fview%3Fres_id%3D4&reserved=0';
const allowed = [mailPreviewLink(wrapped)!];
const token = '123456-234567-345678-456789';

function Harness({
  documentToken = token,
  links = allowed,
  enabled = true,
  trustedOrigins = ['https://erp.rzcloud.ch'],
}: {
  documentToken?: string;
  links?: MailPreviewLink[];
  enabled?: boolean;
  trustedOrigins?: string[];
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const navigation = useMailPreviewNavigation({
    frameRef,
    documentToken,
    links,
    enabled,
    trustedOrigins,
  });
  return (
    <>
      <button aria-label="Before frame" />
      <iframe ref={frameRef} title="Mail preview" />
      <MailPreviewLinkDialog navigation={navigation} />
    </>
  );
}

function dispatchLink(
  data: object = { type: 'mail-preview-link', token, index: 0 },
  origin = 'null',
  source: Window | null = (screen.getByTitle('Mail preview') as HTMLIFrameElement).contentWindow,
) {
  act(() => window.dispatchEvent(new MessageEvent('message', { data, origin, source })));
}

test('the hash permits only the exact static script and no mail source interpolation', () => {
  expect(MAIL_PREVIEW_BRIDGE_HASH).toBe(
    `sha256-${createHash('sha256').update(MAIL_PREVIEW_BRIDGE_SCRIPT).digest('base64')}`,
  );
  expect(MAIL_PREVIEW_BRIDGE_SCRIPT).not.toMatch(/window\.open|location\s*=|innerHTML|eval\(/);
  expect(MAIL_PREVIEW_BRIDGE_SCRIPT).toContain('event.isTrusted');
});

test('a current opaque frame opens a dialog with the original Safe Links URL only', () => {
  render(<Harness />);
  dispatchLink();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('erp.rzcloud.ch', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('com_ui_mail_link_safelinks')).toBeInTheDocument();
  const link = screen.getByRole('link');
  expect(link).toHaveAttribute('href', wrapped);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(screen.getByRole('textbox')).toHaveValue(wrapped);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});

test.each([
  ['wrong type', { type: 'other', token, index: 0 }],
  ['old token', { type: 'mail-preview-link', token: 'old', index: 0 }],
  ['negative index', { type: 'mail-preview-link', token, index: -1 }],
  ['fractional index', { type: 'mail-preview-link', token, index: 0.5 }],
  ['string index', { type: 'mail-preview-link', token, index: '0' }],
  ['missing link', { type: 'mail-preview-link', token, index: 99 }],
  ['infinite index', { type: 'mail-preview-link', token, index: Infinity }],
  ['unsolicited URL', { type: 'mail-preview-link', token, index: 0, url: 'https://evil.test' }],
  ['array message', ['mail-preview-link', token, 0]],
])('ignores %s', (_name, data) => {
  render(<Harness />);
  dispatchLink(data);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('ignores foreign windows, nonopaque origins and absent message sources', () => {
  render(<Harness />);
  dispatchLink(undefined, 'https://erp.rzcloud.ch');
  dispatchLink(undefined, 'null', window);
  dispatchLink(undefined, 'null', null);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('revalidates the current origin policy and never trusts destination metadata', () => {
  const forged = [
    { ...allowed[0], href: 'https://evil.test', destination: allowed[0].destination },
  ];
  const { rerender } = render(<Harness links={forged} />);
  dispatchLink();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness trustedOrigins={[]} />);
  dispatchLink();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness enabled={false} />);
  dispatchLink();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('mail changes and revoked policies immediately remove the dialog and stale events stay inert', () => {
  const { rerender } = render(<Harness />);
  dispatchLink();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<Harness documentToken="next" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  dispatchLink();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  dispatchLink({ type: 'mail-preview-link', token: 'next', index: 0 });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<Harness documentToken="next" enabled={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<Harness documentToken="next" enabled />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('removes a changed mapping without treating the old index as a new approval', () => {
  const { rerender } = render(<Harness />);
  dispatchLink();
  rerender(<Harness links={[mailPreviewLink('https://erp.rzcloud.ch/other')!]} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('copy reports successful completion and clipboard failure separately', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<Harness />);
  dispatchLink();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_link_copy' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('com_ui_mail_copied'));
  expect(writeText).toHaveBeenCalledWith(wrapped);
  writeText.mockRejectedValueOnce(new Error('Denied'));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_mail_link_copy' }));
  await waitFor(() =>
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_mail_link_copy_failed'),
  );
});

test('Escape closes the focus-trapped dialog and returns focus to the preview frame', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const frame = screen.getByTitle('Mail preview');
  frame.focus();
  dispatchLink();
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);
  const close = screen.getByRole('button', { name: 'com_ui_mail_close' });
  close.focus();
  await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(frame).toHaveFocus());
});

test('unmount removes the message listener', () => {
  const remove = jest.spyOn(window, 'removeEventListener');
  const { unmount } = render(<Harness />);
  unmount();
  expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
});
