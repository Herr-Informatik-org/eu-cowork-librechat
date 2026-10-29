import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
}) => {
  test.setTimeout(90000);
  const directory = await mkdtemp(path.join(tmpdir(), 'local-folder-e2e-'));
  const marker = 'LOCAL_FOLDER_BROWSER_EXCERPT';
  await writeFile(
    path.join(directory, 'browser.txt'),
    marker + '\n' + 'normal line\n'.repeat(20000) + 'UNREQUESTED_FILE_TAIL',
  );
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  // Exercise the directory-input fallback with actual browser File objects.
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }),
  );
  try {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await page.getByRole('button', { name: 'Tools Options' }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByTestId('tools-menu-local-folder').click();
    await (await chooserPromise).setFiles(directory);
    const remove = page.getByRole('button', {
      name: `Ordnerzugriff entfernen: ${path.basename(directory)}`,
    });
    await expect(remove).toBeVisible();
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
    await expect(remove).toBeVisible();
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
    await remove.click();
    await expect(remove).not.toBeVisible();
    const after = await sendMessage(page, 'E2E_LOCAL_FOLDER:browser.txt');
    expect(after.request().postDataJSON().ephemeralAgent?.localFolders).toBeUndefined();
    await expect(
      messagesView(page).getByText('E2E local folder unavailable', { exact: true }),
    ).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
