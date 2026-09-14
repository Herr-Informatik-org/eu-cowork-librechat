import { useEffect, useState } from 'react';
import { Switch } from '@librechat/client';
import {
  notificationsEnabled,
  notificationsSupported,
  setNotificationsEnabled,
} from '~/utils/notifications';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';

export default function Notifications() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const [enabled, setEnabled] = useState(() => notificationsEnabled(user?.id));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = notificationsSupported();
  const [permission, setPermission] = useState(supported ? Notification.permission : 'default');

  useEffect(() => {
    const refresh = () => {
      setEnabled(notificationsEnabled(user?.id));
      setPermission(supported ? Notification.permission : 'default');
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [user?.id, supported]);

  const toggle = async (checked: boolean) => {
    if (!user?.id) return;
    setPending(true);
    setFailed(false);
    try {
      const nextPermission = checked ? await Notification.requestPermission() : permission;
      setPermission(nextPermission);
      const nextEnabled = checked && nextPermission === 'granted';
      setNotificationsEnabled(user.id, nextEnabled);
      setEnabled(nextEnabled);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  let description: Parameters<typeof localize>[0] = 'com_ui_notifications_description';
  if (!supported) description = 'com_ui_notifications_unsupported';
  else if (permission === 'denied') description = 'com_ui_notifications_blocked';
  else if (failed) description = 'com_ui_notifications_failed';

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div id="desktop-notifications-label">{localize('com_ui_desktop_notifications')}</div>
        <p
          id="desktop-notifications-description"
          className="mt-1 text-sm text-text-secondary"
          role="status"
        >
          {localize(description)}
        </p>
      </div>
      <Switch
        id="desktop-notifications"
        checked={enabled && permission === 'granted'}
        disabled={!supported || !user?.id || pending || permission === 'denied'}
        onCheckedChange={toggle}
        aria-labelledby="desktop-notifications-label"
        aria-describedby="desktop-notifications-description"
        className="shrink-0"
      />
    </div>
  );
}
