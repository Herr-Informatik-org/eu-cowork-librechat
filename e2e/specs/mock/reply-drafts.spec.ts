import { expect, test } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, sendMessage } from './helpers';

test('keeps a question reply as ghost text until Tab and sends only after Enter', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessage(page, 'E2E_COMPOSER_REPLY_DRAFT');
  const input = page.getByTestId('text-input');
  const ghost = page.getByTestId('reply-suggestion');
  const send = page.getByTestId('send-button');
  const answer = 'Ja, beginne bitte mit AarPower AG.';
  await expect(ghost).toContainText(answer);
  await expect(input).toHaveValue('');
  await expect(send).toBeDisabled();
  await expect(page.getByText('ANTWORT:', { exact: false })).toHaveCount(0);
  await page.reload();
  await expect(ghost).toContainText(answer);
  await input.focus();
  await input.press('Tab');
  await expect(input).toHaveValue(answer);
  await expect(ghost).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(send).toBeEnabled();
  await input.press('Control+z');
  await expect(input).toHaveValue('');
  await expect(ghost).toHaveCount(0);
  await input.fill(answer);
  const response = page.waitForResponse(
    (result) => result.request().method() === 'POST' && result.url().includes('/agents'),
  );
  await input.press('Enter');
  expect((await response).ok()).toBeTruthy();
  await expect(input).toHaveValue('');
});

test('preserves an existing draft, dismisses with Escape and resets on a new chat', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessage(page, 'E2E_COMPOSER_REPLY_DRAFT');
  const input = page.getByTestId('text-input');
  const ghost = page.getByTestId('reply-suggestion');
  await expect(ghost).toBeVisible();
  await input.fill('Ich möchte zuerst etwas anderes prüfen.');
  await expect(ghost).toHaveCount(0);
  await input.press('Tab');
  await expect(input).toHaveValue('Ich möchte zuerst etwas anderes prüfen.');
  await input.fill('');
  await input.press('Escape');
  await expect(ghost).toHaveCount(0);
  await page.goto(NEW_CHAT_PATH);
  await expect(ghost).toHaveCount(0);
});
