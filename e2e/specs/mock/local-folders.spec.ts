import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

test('reads a selected local folder through the real pause and resume path without uploading', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'local-folder-e2e-'));
  const directory = path.join(fixtureRoot, 'Projektunterlagen');
  await mkdir(directory);
  const marker = 'LOCAL_FOLDER_BROWSER_EXCERPT';
  await writeFile(
    path.join(directory, 'browser.txt'),
    marker + '\n' + 'normal line\n'.repeat(20000) + 'UNREQUESTED_FILE_TAIL',
  );
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  // Exercise the directory-input fallback with actual browser File objects.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    localStorage.setItem('color-theme', 'system');
  });
  try {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const menuButton = page.getByTestId('local-folder-menu-button');
    await expect(menuButton).toHaveText('Kein Ordner');
    await menuButton.click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Ordner öffnen…' }).click();
    await (await chooserPromise).setFiles(directory);
    await expect(menuButton).toHaveText(path.basename(directory));
    const remove = page.getByRole('menuitemcheckbox', {
      name: `Ordnerzugriff entfernen: ${path.basename(directory)}`,
    });
    await menuButton.click();
    await expect(remove).toBeVisible();
    await expect(remove).toHaveAttribute('aria-checked', 'true');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const screenshotPath = testInfo.outputPath(`local-folder-menu-${theme}.png`);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(`local-folder-menu-${theme}`, {
        path: screenshotPath,
        contentType: 'image/png',
      });
    }
    await page.keyboard.press('Escape');
    const response = await sendMessage(page, 'E2E_LOCAL_FOLDER:browser.txt');
    const body = response.request().postDataJSON();
    expect(body.ephemeralAgent.localFolders).toEqual([
      { id: expect.any(String), label: path.basename(directory) },
    ]);
    expect(JSON.stringify(body)).not.toContain(marker);
    await expect(messagesView(page).getByText(/E2E approval outcomes:/)).toContainText(marker, {
      timeout: 45000,
    });
    await expect(page).not.toHaveURL(/\/c\/new$/);
    await expect(menuButton).toHaveText(path.basename(directory));
    const resume = requests.find(
      (request) => new URL(request.url()).pathname === '/api/agents/chat/resume',
    );
    expect(resume).toBeDefined();
    const resumed = resume!.postDataJSON();
    expect(resumed.decisions[0].decision).toBe('respond');
    expect(resumed.decisions[0].responseText.length).toBeLessThanOrEqual(16000);
    expect(resumed.decisions[0].responseText).toContain(marker);
    expect(JSON.parse(resumed.decisions[0].responseText).source.path).toBe('browser.txt');
    expect(resumed.decisions[0].responseText).not.toContain('UNREQUESTED_FILE_TAIL');
    expect(
      requests.some(
        (request) =>
          request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/files'),
      ),
    ).toBe(false);
    await menuButton.click();
    await remove.click();
    await expect(menuButton).toHaveText('Kein Ordner');
    const after = await sendMessage(page, 'E2E_LOCAL_FOLDER:browser.txt');
    expect(after.request().postDataJSON().ephemeralAgent?.localFolders).toBeUndefined();
    await expect(
      messagesView(page).getByText('E2E local folder unavailable', { exact: true }),
    ).toBeVisible();
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
