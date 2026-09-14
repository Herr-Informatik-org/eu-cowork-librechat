import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Notifications from './Notifications';
import { notificationsEnabled, setNotificationsEnabled } from '~/utils/notifications';

jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'user-1' } }) }));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

const requestPermission = jest.fn();
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: Object.assign(jest.fn(), { permission: 'default', requestPermission }),
  });
});

it('asks permission only when enabled and remembers the setting', async () => {
  requestPermission.mockResolvedValue('granted');
  render(<Notifications />);
  expect(requestPermission).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
  expect(notificationsEnabled('user-1')).toBe(true);
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked());
  expect(notificationsEnabled('user-1')).toBe(false);
  expect(requestPermission).toHaveBeenCalledTimes(1);
});

it.each(['denied', 'default'])('stays disabled after permission is %s', async (permission) => {
  requestPermission.mockResolvedValue(permission);
  render(<Notifications />);
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('switch')).not.toBeChecked();
  expect(notificationsEnabled('user-1')).toBe(false);
  if (permission === 'denied') {
    await screen.findByText('com_ui_notifications_blocked');
  }
});

it('shows blocked permissions after returning from browser settings', () => {
  Object.defineProperty(Notification, 'permission', { configurable: true, value: 'denied' });
  setNotificationsEnabled('user-1', true);
  render(<Notifications />);
  expect(screen.getByRole('switch')).toBeDisabled();
  expect(screen.getByRole('switch')).not.toBeChecked();
  expect(screen.getByText('com_ui_notifications_blocked')).toBeVisible();
});

it('explains unavailable browser support', () => {
  Object.defineProperty(window, 'Notification', { value: undefined });
  render(<Notifications />);
  expect(screen.getByRole('switch')).toBeDisabled();
  expect(screen.getByText('com_ui_notifications_unsupported')).toBeVisible();
});

it('reports storage errors without pretending the setting was saved', async () => {
  requestPermission.mockResolvedValue('granted');
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  render(<Notifications />);
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByText('com_ui_notifications_failed');
  expect(screen.getByRole('switch')).not.toBeChecked();
});
