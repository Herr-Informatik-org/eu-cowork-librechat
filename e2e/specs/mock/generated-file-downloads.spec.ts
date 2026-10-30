import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { withMongo } from './db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

async function expectDownload(page: Page, control: Locator, filename: string, bytes: Buffer) {
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await control.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!)).toEqual(bytes);
}

test('downloads JSON and XML from genuine chat chips and registered Markdown links', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90000);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'generated-file-downloads-'));
  const requests: Request[] = [];
  const external: string[] = [];
  page.on('request', (request) => requests.push(request));
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.fallback();
    external.push(url.href);
    return route.fulfill({ status: 418, body: 'External download must not be requested' });
  });
  // A cloud-backed attachment must use the authenticated byte stream, never a signed URL.
  await page.route('**/api/files/download-url/**', (route) =>
    route.fulfill({
      json: { url: 'https://signed-download.example.test/unexpected', filename: 'unexpected.json' },
    }),
  );
  let conversationId = '';
  const fileIds: string[] = [];
  try {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessage(page, 'Erstelle synthetische JSON- und XML-Dateien.');
    await expect(mockReply(page)).toBeVisible();
    await expect(page).not.toHaveURL(/\/c\/new$/);
    conversationId = new URL(page.url()).pathname.split('/').pop()!;
    const fixtures = [
      {
        extension: 'json',
        bytes: Buffer.from('{\r\n  "kunde": "Müller", "tickets": [1, 2]\r\n}\n'),
      },
      {
        extension: 'xml',
        bytes: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><kunde>Müller</kunde>\r\n'),
      },
    ].map((fixture) => ({
      ...fixture,
      id: randomUUID(),
      filename: `kundendienst_letzte160_tickets.${fixture.extension}`,
      href: `https://downloads.example.test/kundendienst_letzte160_tickets.${fixture.extension}`,
    }));
    for (const fixture of fixtures) {
      fileIds.push(fixture.id);
      await writeFile(path.join(fixtureRoot, fixture.filename), fixture.bytes);
    }
    const seeded = await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email: getPrimaryE2EUser().email });
      expect(user).not.toBeNull();
      const owner = user!._id.toString();
      const message = await db
        .collection('messages')
        .findOne({ conversationId, isCreatedByUser: false });
      expect(message).not.toBeNull();
      const attachments = fixtures.map((fixture) => ({
        file_id: fixture.id,
        filename: fixture.filename,
        filepath: fixture.href,
        conversationId,
        messageId: message!.messageId,
        toolCallId: `download-fixture-${fixture.extension}`,
        bytes: fixture.bytes.length,
        // Exercise both cloud-backed metadata and historical attachments without source/user.
        ...(fixture.extension === 'json' ? { user: owner, source: 'cloudfront' } : {}),
      }));
      await db.collection('files').insertMany(
        fixtures.map((fixture) => ({
          file_id: fixture.id,
          user: owner,
          filename: fixture.filename,
          filepath: fixture.href,
          storageKey: path.join(fixtureRoot, fixture.filename),
          source: 'local',
          type: `application/${fixture.extension}`,
          context: 'execute_code',
          bytes: fixture.bytes.length,
          object: 'file',
          embedded: false,
          usage: 0,
          conversationId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
      const markdown = fixtures
        .map(
          (fixture) =>
            `[${fixture.extension.toUpperCase()}-Datei herunterladen](${fixture.href})\n\n` +
            `[${fixture.extension.toUpperCase()} Sandbox](sandbox:/mnt/data/${fixture.filename})`,
        )
        .join('\n\n');
      await db.collection('messages').updateOne(
        { _id: message!._id },
        {
          $set: {
            text: markdown,
            attachments,
            content: [
              ...attachments.map((attachment) => ({
                type: 'tool_call',
                tool_call: {
                  id: attachment.toolCallId,
                  name: 'execute_code',
                  type: 'tool_call',
                  args: '{"lang":"py","code":"pass"}',
                  output: 'Synthetische Datei gespeichert.',
                  progress: 1,
                },
              })),
              { type: 'text', text: markdown },
            ],
          },
        },
      );
      return { messageId: message!.messageId, attachments };
    });
    await page.reload();
    const originalURL = page.url();
    await messagesView(page).getByRole('button', { name: 'Show 2 files', exact: true }).click();
    for (const fixture of fixtures) {
      const label = `${fixture.extension.toUpperCase()}-Datei herunterladen`;
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
      const chip = messagesView(page).getByLabel(fixture.filename, { exact: true });
      await expect(chip).toBeVisible();
      await expectDownload(page, chip, fixture.filename, fixture.bytes);
      await expectDownload(
        page,
        page.getByRole('button', { name: label, exact: true }),
        fixture.filename,
        fixture.bytes,
      );
      await expectDownload(
        page,
        page.getByRole('button', {
          name: `${fixture.extension.toUpperCase()} Sandbox`,
          exact: true,
        }),
        fixture.filename,
        fixture.bytes,
      );
    }
    expect(page.url()).toBe(originalURL);
    expect(context.pages()).toHaveLength(1);
    expect(external).toEqual([]);
    expect(
      requests.some((request) => new URL(request.url()).pathname.includes('/download-url/')),
    ).toBe(false);
    const downloads = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/api/files/download/'),
    );
    expect(downloads).toHaveLength(6);
    expect(
      downloads.every((request) => new URL(request.url()).searchParams.get('direct') !== 'true'),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('json-xml-downloads.png') });

    // Equal names or equal URLs with different IDs must never choose the first file silently.
    await withMongo(async (db) => {
      await db.collection('messages').updateOne(
        { messageId: seeded.messageId },
        {
          $set: {
            attachments: [
              seeded.attachments[0],
              { ...seeded.attachments[0], file_id: fixtures[1].id },
            ],
          },
        },
      );
    });
    await page.reload();
    const before = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith('/api/files/download/'),
    ).length;
    await page.getByRole('button', { name: 'JSON-Datei herunterladen', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Bitte über die Anhänge herunterladen.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'JSON Sandbox', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Bitte über die Anhänge herunterladen.' }),
    ).toHaveCount(2);
    expect(
      requests.filter((request) =>
        new URL(request.url()).pathname.startsWith('/api/files/download/'),
      ),
    ).toHaveLength(before);
    expect(context.pages()).toHaveLength(1);
    expect(external).toEqual([]);
  } finally {
    await withMongo(async (db) => {
      await db.collection('files').deleteMany({ file_id: { $in: fileIds } });
      if (conversationId) {
        await db.collection('messages').deleteMany({ conversationId });
        await db.collection('conversations').deleteMany({ conversationId });
      }
    });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
