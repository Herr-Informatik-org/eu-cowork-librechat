import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type {
  MailWorkspaceContent,
  MailWorkspacePreview,
  MailWorkspaceResult,
  MailWorkspaceStatus,
} from 'librechat-data-provider';

const trustedOrigin = 'https://erp.preview.example.test';
const destination = `${trustedOrigin}/odoo/project/42`;
const safeLink = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(destination)}&data=synthetic`;
const html = `<p>Browser-Testmail</p><p><a href="${destination}">Projekt direkt</a></p><p><a href="${safeLink.replaceAll('&', '&amp;')}">Projekt via Safe Links</a></p><p><a href="https://untrusted.example.test/private">Gesperrtes Ziel</a></p>`;

async function interceptExternal(context: BrowserContext) {
  const requests: { url: string; referer?: string }[] = [];
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.fallback();
      return;
    }
    requests.push({ url: url.href, referer: route.request().headers().referer });
    await route.fulfill({ contentType: 'text/html', body: '<p>Synthetisches Linkziel</p>' });
  });
  return requests;
}

async function openMail(page: Page, overrides: Partial<MailWorkspacePreview> = {}) {
  const row: MailWorkspaceResult = {
    id: 'preview-fixture',
    revision: 'preview-revision',
    subject: 'Synthetische Mailvorschau',
    sender: 'mail-preview@example.test',
    receivedAt: '2026-10-30T08:00:00Z',
    priority: 'normal',
    action: 'reply',
    summary: 'Lokale Browserprüfung ohne echte Maildaten.',
    reason: 'Synthetische Testmail',
    questions: [],
    draftStatus: 'none',
  };
  const status: MailWorkspaceStatus = {
    available: true,
    modelLabel: 'Synthetisches Modell',
    connection: { connected: true, mailbox: 'preview-owner@example.test' },
    settings: {
      enabled: true,
      consentVersion: '2026-10-27',
      mode: 'manual',
      weekdays: [1, 2, 3, 4, 5],
      startTime: '08:00',
      endTime: '17:00',
      timeZone: 'Europe/Zurich',
      intervalMinutes: 30,
      history: { mode: 'all' },
    },
    activity: {
      running: false,
      pending: 0,
      hasMore: false,
      history: { mode: 'all', processed: 1, pending: 0, hasMore: false, completed: true },
    },
    results: [row],
  };
  const content: MailWorkspaceContent = {
    resultId: row.id,
    mailbox: status.connection.mailbox!,
    message: {
      subject: row.subject,
      sender: row.sender,
      receivedAt: row.receivedAt,
      body: 'Synthetische Mailvorschau mit Projektlinks.',
      bodyTruncated: false,
      preview: {
        html,
        linksEnabled: true,
        trustedOrigins: [trustedOrigin],
        linkCheck: {
          status: 'not_listed',
          checkedAt: '2026-10-30T08:10:00Z',
          sourceUpdatedAt: '2026-10-30T08:00:00Z',
          blocked: 0,
        },
        blockedImages: 2,
        truncated: false,
        warnings: ['Synthetischer Vorschauhinweis'],
        ...overrides,
      },
    },
  };
  // These fixtures replace only mailbox APIs. Authentication, routing and React rendering stay real.
  await page.route('**/api/mail/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/mail', '');
    const responses: Record<string, unknown> = {
      '/availability': { available: true },
      '/status': status,
      '/inbox': { results: [row] },
      '/results': { results: [row] },
      '/move-jobs': { jobs: [] },
      '/research/settings': { available: false, profiles: [], skills: [] },
      '/followup/settings': { profiles: [] },
      '/folders': { folders: [] },
      [`/results/${row.id}/content`]: content,
    };
    await route.fulfill({
      status: Object.hasOwn(responses, path) ? 200 : 404,
      json: responses[path] ?? { error: 'Unerwarteter Testaufruf' },
    });
  });
  await page.goto('/mail');
  await page.getByRole('button', { name: /mail-preview@example.test/ }).click();
  const frame = page.frameLocator('iframe[title="Originalmail"]');
  await expect(frame.getByText('Browser-Testmail')).toBeVisible();
  return frame;
}

test('keeps preview information compact and confirms genuine iframe clicks before navigation', async ({
  page,
  context,
}, testInfo) => {
  const externalRequests = await interceptExternal(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('color-theme', 'system'));
  const frame = await openMail(page);
  const info = page.getByRole('button', { name: 'Info', exact: true });
  await expect(page.getByRole('button', { name: 'Kopieren', exact: true })).toBeVisible();
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Synthetischer Vorschauhinweis')).not.toBeVisible();
  await expect(page.getByText(/2 Bilder wurden nicht geladen/)).not.toBeVisible();
  await info.scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await page.screenshot({ path: testInfo.outputPath(`mail-preview-compact-${theme}.png`) });
  }
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Synthetischer Vorschauhinweis')).toBeVisible();
  await expect(page.getByText(/2 Bilder wurden nicht geladen/)).toBeVisible();
  await expect(page.getByText(/Vorschau geprüft:/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mail-preview-info.png') });
  await info.click();
  await expect(page.getByText('Synthetischer Vorschauhinweis')).not.toBeVisible();
  const iframe = page.locator('iframe[title="Originalmail"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await iframe.evaluate((element: HTMLIFrameElement) => element.contentDocument)).toBeNull();

  for (const [label, href] of [
    ['Projekt direkt', destination],
    ['Projekt via Safe Links', safeLink],
  ]) {
    const count = externalRequests.length;
    await frame.getByRole('link', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Link öffnen', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('erp.preview.example.test', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('definition').getByText(destination, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Link zum Öffnen und Kopieren' })).toHaveValue(
      href,
    );
    expect(context.pages()).toHaveLength(1);
    expect(externalRequests).toHaveLength(count);
    const open = dialog.getByRole('link', { name: 'In neuem Tab öffnen', exact: true });
    await expect(open).toHaveAttribute('href', href);
    await expect(open).toHaveAttribute('rel', /noopener.*noreferrer/);
    await dialog.getByRole('button', { name: 'Link kopieren', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Text kopiert');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);
    if (href === safeLink) {
      await expect(dialog.getByText(/Microsoft Safe Links/)).toBeVisible();
    }
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const screenshotPath = testInfo.outputPath(
        `mail-link-${label === 'Projekt direkt' ? 'direct' : 'safelinks'}-${theme}.png`,
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach(`mail-link-${theme}`, {
        path: screenshotPath,
        contentType: 'image/png',
      });
    }
    const popupPromise = context.waitForEvent('page');
    await open.click();
    const popup = await popupPromise;
    await expect(popup.getByText('Synthetisches Linkziel')).toBeVisible();
    await expect(popup).toHaveURL(href);
    expect(externalRequests.at(-1)).toEqual({ url: href, referer: undefined });
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
  expect(externalRequests).toHaveLength(2);
});

test('keeps foreign scripts, event handlers, images and unapproved links inert in the real frame', async ({
  page,
  context,
}) => {
  const externalRequests = await interceptExternal(context);
  const frame = await openMail(page, {
    html: `${html}
      <script>document.body.dataset.mailExecuted='script';fetch('https://untrusted.example.test/script')</script>
      <img src="https://untrusted.example.test/pixel" onerror="document.body.dataset.mailExecuted='image'">
      <p onclick="document.body.dataset.mailExecuted='event'">Ereignistext</p>
      <a href="javascript:document.body.dataset.mailExecuted='url'">JavaScript-Ziel</a>
      <form action="https://untrusted.example.test/form"><button>Formular senden</button></form>
      <iframe src="https://untrusted.example.test/frame"></iframe>`,
  });
  await expect(frame.getByRole('link', { name: 'Gesperrtes Ziel' })).toHaveCount(0);
  await expect(frame.getByRole('link', { name: 'JavaScript-Ziel' })).toHaveCount(0);
  await expect(frame.locator('form, iframe, button, [onclick], [onerror]')).toHaveCount(0);
  await frame.getByText('Gesperrtes Ziel').click();
  await frame.getByText('Ereignistext').click();
  await expect(page.getByRole('dialog', { name: 'Link öffnen' })).not.toBeVisible();
  await expect(frame.locator('body')).not.toHaveAttribute('data-mail-executed');
  // Bypass sanitization only in this probe to independently verify the browser's CSP boundary.
  const cspBlocked = await frame.locator('body').evaluate(async (body) => {
    const violation = new Promise<boolean>((resolve) => {
      document.addEventListener(
        'securitypolicyviolation',
        (event) => {
          if (event.violatedDirective === 'script-src-elem') resolve(true);
        },
        { once: true },
      );
      setTimeout(() => resolve(false), 2000);
    });
    const script = document.createElement('script');
    script.textContent = "document.body.dataset.mailExecuted='injected'";
    body.append(script);
    return violation;
  });
  expect(cspBlocked).toBe(true);
  await expect(frame.locator('body')).not.toHaveAttribute('data-mail-executed');
  expect(context.pages()).toHaveLength(1);
  expect(externalRequests).toEqual([]);
});

for (const status of ['disabled', 'unavailable'] as const) {
  test(`does not activate mail links when their check is ${status}`, async ({ page, context }) => {
    const externalRequests = await interceptExternal(context);
    const frame = await openMail(page, { linkCheck: { status, blocked: 0 } });
    await expect(frame.getByRole('link')).toHaveCount(0);
    await expect(page.locator('iframe[title="Originalmail"]')).toHaveAttribute('sandbox', '');
    await frame.getByText('Projekt direkt').click();
    await expect(page.getByRole('dialog', { name: 'Link öffnen' })).not.toBeVisible();
    expect(context.pages()).toHaveLength(1);
    expect(externalRequests).toEqual([]);
  });
}
