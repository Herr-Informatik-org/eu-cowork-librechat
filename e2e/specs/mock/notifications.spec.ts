import { expect, test } from '@playwright/test';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessage } from './helpers';

test('settings opt-in, foreground suppression, background completion and click-through', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    const NativeNotification = window.Notification;
    const notices: Notification[] = [];
    Object.assign(window, { completionNotices: notices, notificationBackground: false });
    Object.defineProperty(document, 'hasFocus', {
      value: () => !(window as Window & { notificationBackground: boolean }).notificationBackground,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: () =>
        (window as Window & { notificationBackground: boolean }).notificationBackground
          ? 'hidden'
          : 'visible',
    });
    window.Notification = class extends NativeNotification {
      constructor(title: string, options?: NotificationOptions) {
        super(title, options);
        notices.push(this);
      }
    };
  });
  await page.goto('/c/new');
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: /Settings|Einstellungen/ }).click();
  const toggle = page.getByRole('switch', { name: 'Desktop-Benachrichtigungen' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('notifications-settings.png') });
  await page.keyboard.press('Escape');
  await sendMessage(page, 'E2E_REPLY:foreground-notification');
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 30000,
  });
  const count = () =>
    page.evaluate(
      () => (window as Window & { completionNotices: Notification[] }).completionNotices.length,
    );
  expect(await count()).toBe(0);
  await sendMessage(page, 'E2E_SLOW_REPLY:background-notification');
  await page.evaluate(() => Object.assign(window, { notificationBackground: true }));
  await expect.poll(count, { timeout: 45000 }).toBe(1);
  const completedURL = page.url();
  await page.getByTestId('new-chat-button').first().click();
  await page.evaluate(() => {
    const notice = (window as Window & { completionNotices: Notification[] }).completionNotices[0];
    notice.dispatchEvent(new Event('click'));
  });
  await expect(page).toHaveURL(completedURL);
  expect(await count()).toBe(1);
});
