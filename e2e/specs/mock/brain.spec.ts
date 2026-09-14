import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  getAccessToken,
  MOCK_ENDPOINTS,
  mockReply,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';
import { getSecondaryE2EUser } from '../../setup/users.mock';

const fact =
  'Alpenblick verwendet für Offerten ausschliesslich CHF und erwartet eine Zusammenfassung auf Deutsch.';

async function api(page: Page, method: string, path: string, body?: unknown) {
  const token = await getAccessToken(page);
  const response = await page.request.fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), body: await response.json() };
}

test('learns automatically, recalls in a fresh chat, exposes provenance and forgets source deletion', async ({
  page,
}, testInfo) => {
  test.setTimeout(150000);
  await page.goto('/c/new');
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  expect((await api(page, 'GET', '/api/brain/status')).body.enabled).toBe(true);
  // No memory-tool toggle and no explicit remember instruction are required.
  await sendMessage(page, fact);
  await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[a-f0-9-]{36}$/);
  const sourceId = page.url().split('/').at(-1);
  await expect
    .poll(async () => (await api(page, 'GET', '/api/brain/graph')).body.nodes.length, {
      timeout: 45000,
    })
    .toBe(1);
  const learned = (await api(page, 'GET', '/api/brain/graph')).body.nodes[0];
  expect(learned.text).toBe(fact);
  expect(learned.sources[0].conversationId).toBe(sourceId);
  expect(learned.sources[0].excerpt).toBe(fact);
  if (process.env.E2E_BRAIN_SEPARATE_MODEL === 'true') {
    const provider = await page.request.get(
      `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}/health`,
    );
    expect((await provider.json()).learningRequests).toContainEqual({
      model: 'mock-brain-review-model',
      usedSeparateProviderKey: true,
    });
  }

  await page.goto('/c/new');
  await sendMessage(
    page,
    'Was muss ich bei einer Offerte für Alpenblick beachten? E2E_BRAIN_PROBE',
  );
  await expect(
    messagesView(page).getByText('E2E Brain context verified', { exact: true }),
  ).toBeVisible({
    timeout: 30000,
  });
  const recalls = (await api(page, 'GET', '/api/brain/recalls')).body;
  expect(JSON.stringify(recalls)).toContain(learned.id);

  await page.getByTestId('nav-panel-brain').click();
  await page.getByRole('button', { name: 'Explore Brain' }).click();
  const workspace = page.getByTestId('brain-workspace');
  await expect(workspace).toBeVisible();
  await workspace.getByRole('button', { name: `${learned.title} · Projects`, exact: true }).click();
  await expect(workspace.getByText(fact, { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('brain-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('brain-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');

  expect((await api(page, 'PATCH', '/api/memories/preferences', { memories: false })).status).toBe(
    200,
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/c/new');
  await sendMessage(
    page,
    'Was muss ich bei einer Offerte für Alpenblick beachten? E2E_BRAIN_PROBE_ABSENT',
  );
  await expect(
    messagesView(page).getByText('E2E Brain context verified', { exact: true }),
  ).toBeVisible({
    timeout: 30000,
  });
  expect((await api(page, 'GET', '/api/brain/graph')).body.nodes).toHaveLength(1);
  expect((await api(page, 'PATCH', '/api/memories/preferences', { memories: true })).status).toBe(
    200,
  );

  expect(
    (await api(page, 'DELETE', '/api/convos', { arg: { conversationId: sourceId } })).status,
  ).toBe(201);
  expect((await api(page, 'GET', '/api/brain/graph')).body.nodes).toHaveLength(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/c/new');
  await sendMessage(
    page,
    'Was muss ich bei einer Offerte für Alpenblick beachten? E2E_BRAIN_PROBE_ABSENT',
  );
  await expect(
    messagesView(page).getByText('E2E Brain context verified', { exact: true }),
  ).toBeVisible({
    timeout: 30000,
  });
});

test('manages genuine memories in the desktop and mobile knowledge map', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  await page.goto('/c/new');
  const fixtures = [
    ['project', 'Alpenblick Telefonie'],
    ['project', 'Kundenportal'],
    ['project', 'Quartalsplanung'],
    ['person', 'Projektleitung'],
    ['person', 'Technischer Kontakt'],
    ['person', 'Einkauf'],
    ['decision', 'Pilot im Oktober'],
    ['decision', 'Angebote in CHF'],
    ['decision', 'Freigabe vor Rollout'],
    ['preference', 'Schweizer Schreibweise'],
    ['preference', 'Kurze Zusammenfassungen'],
    ['preference', 'Klare nächste Schritte'],
    ['fact', 'Standorte und Teams'],
    ['fact', 'Servicezeiten'],
    ['fact', 'Systemübersicht'],
    ['procedure', 'Angebot vorbereiten'],
    ['procedure', 'Änderung dokumentieren'],
    ['procedure', 'Abnahme durchführen'],
  ];
  const ids: string[] = [];
  for (const [kind, title] of fixtures) {
    const created = await api(page, 'POST', '/api/brain/nodes', {
      kind,
      title,
      text: `${title}: Synthetisches Projektwissen für die lokale Oberflächenprüfung.`,
      scope: kind === 'preference' ? null : 'Alpenblick',
      tags: [kind === 'preference' ? 'Arbeitsstil' : 'Alpenblick'],
      relatedIds: ids.length ? [ids[0]] : [],
    });
    expect(created.status).toBe(201);
    ids.push(created.body.node.id);
  }
  try {
    await page.evaluate(() => localStorage.setItem('color-theme', 'system'));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await page.getByTestId('nav-panel-brain').click();
    await page.getByRole('button', { name: 'Explore Brain' }).click();
    const workspace = page.getByTestId('brain-workspace');
    await expect(workspace).toBeVisible();
    await expect(
      workspace.getByRole('button', { name: 'Alpenblick Telefonie · Projects', exact: true }),
    ).toBeVisible();
    const backgrounds: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const readPalette = () =>
        workspace.evaluate((element) => {
          const probe = document.createElement('div');
          probe.style.backgroundColor = 'var(--surface-dialog)';
          probe.style.color = 'var(--text-primary)';
          document.body.append(probe);
          const expected = getComputedStyle(probe);
          const dialog = getComputedStyle(element.closest('[role="dialog"]')!);
          const heading = getComputedStyle(element.querySelector('h1')!);
          const result = {
            background: dialog.backgroundColor,
            expectedBackground: expected.backgroundColor,
            color: heading.color,
            expectedColor: expected.color,
            font: heading.fontFamily,
            inheritedFont: getComputedStyle(element).fontFamily,
          };
          probe.remove();
          return result;
        });
      // Theme colors transition with the application; inspect their settled values.
      await expect
        .poll(async () => {
          const palette = await readPalette();
          return (
            palette.background === palette.expectedBackground &&
            palette.color === palette.expectedColor
          );
        })
        .toBe(true);
      const palette = await readPalette();
      expect(palette.background).toBe(palette.expectedBackground);
      expect(palette.color).toBe(palette.expectedColor);
      expect(palette.font).toBe(palette.inheritedFont);
      backgrounds.push(palette.background);
      await page.screenshot({
        path: testInfo.outputPath(`brain-knowledge-map-${theme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    expect(backgrounds[0]).not.toBe(backgrounds[1]);
    await page.screenshot({
      path: testInfo.outputPath('brain-knowledge-map.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await workspace.getByTestId('brain-create').click();
    await workspace.getByLabel('Title', { exact: true }).fill('Freigabeprozess');
    await workspace
      .getByLabel('What should stay in memory?')
      .fill('Vor jeder Bestellung wird die Projektleitung um Freigabe gebeten.');
    await workspace.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      workspace
        .getByText('Vor jeder Bestellung wird die Projektleitung um Freigabe gebeten.', {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await workspace.getByRole('button', { name: 'Edit', exact: true }).click();
    await workspace.getByLabel('Title', { exact: true }).fill('Bestellungen freigeben');
    await workspace.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(workspace.getByRole('heading', { name: 'Bestellungen freigeben' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await expect(
        workspace.getByRole('heading', { name: 'Bestellungen freigeben' }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`brain-mobile-details-${theme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.screenshot({
      path: testInfo.outputPath('brain-mobile-details.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await workspace.getByRole('button', { name: 'Forget', exact: true }).click();
    await workspace.getByTestId('brain-forget-confirm').click();
    await expect(
      workspace.getByRole('heading', { name: 'Bestellungen freigeben' }),
    ).not.toBeVisible();
    expect((await api(page, 'GET', '/api/brain/graph?query=Bestellungen')).body.nodes).toHaveLength(
      0,
    );
  } finally {
    for (const id of ids) await api(page, 'DELETE', `/api/brain/nodes/${id}`);
  }
});

test('isolates graph, individual memories, changes and export between users', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  await page.goto('/c/new');
  const created = await api(page, 'POST', '/api/brain/nodes', {
    title: 'Private Projektentscheidung',
    text: 'Das persönliche Projekt A startet im November.',
    kind: 'decision',
    tags: ['Privat'],
    scope: 'Projekt A',
  });
  expect(created.status).toBe(201);
  const node = created.body.node ?? created.body;
  const contextB = await browser.newContext({ storageState: undefined, baseURL });
  try {
    const pageB = await contextB.newPage();
    const user = getSecondaryE2EUser();
    await pageB.goto('/login');
    await pageB.getByRole('link', { name: 'Sign up' }).click();
    await pageB.getByLabel('Full name').fill(user.name);
    await pageB.getByLabel('Email').fill(user.email);
    await pageB.getByTestId('password').fill(user.password);
    await pageB.getByTestId('confirm_password').fill(user.password);
    await pageB.getByLabel('Submit registration').click();
    await pageB.waitForURL(/\/c\/new/);
    await pageB.goto('/login');
    await pageB.getByLabel('Email').fill(user.email);
    await pageB.getByLabel('Password').fill(user.password);
    await pageB.getByTestId('login-button').click();
    await pageB.waitForURL(/\/c\/new/);
    expect((await api(pageB, 'GET', '/api/brain/graph')).body.nodes).toHaveLength(0);
    expect((await api(pageB, 'GET', `/api/brain/nodes/${node.id}`)).status).toBe(404);
    expect(
      (
        await api(pageB, 'PATCH', `/api/brain/nodes/${node.id}`, {
          version: node.version,
          title: 'Fremd',
        })
      ).status,
    ).toBe(404);
    // Forgetting is idempotent; a foreign ID behaves like an absent own ID.
    expect((await api(pageB, 'DELETE', `/api/brain/nodes/${node.id}`)).status).toBe(200);
    expect(JSON.stringify((await api(pageB, 'GET', '/api/brain/export')).body)).not.toContain(
      node.text,
    );
    expect((await api(page, 'GET', `/api/brain/nodes/${node.id}`)).status).toBe(200);
  } finally {
    await contextB.close();
    await api(page, 'DELETE', `/api/brain/nodes/${node.id}`);
  }
});

test('remembers, changes and forgets through actual chat tools', async ({ page }) => {
  test.setTimeout(120000);
  const commandFact = 'Projekt Orion verwendet CHF für Angebote und Deutsch für Zusammenfassungen.';
  const commands = [
    ['remember', `Merke dir: ${commandFact} E2E_BRAIN_COMMAND_REMEMBER`],
    ['update', 'Ändere für Projekt Orion die Währung auf EUR. E2E_BRAIN_COMMAND_UPDATE'],
    ['forget', 'Vergiss die Erinnerung über Projekt Orion. E2E_BRAIN_COMMAND_FORGET'],
  ];
  for (const [action, command] of commands) {
    await page.goto('/c/new');
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessage(page, command);
    await expect(
      messagesView(page).getByText(`E2E Brain ${action} verified`, { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const nodes = (await api(page, 'GET', '/api/brain/graph?query=Orion')).body.nodes;
    if (action === 'forget') {
      expect(nodes).toHaveLength(0);
    } else {
      expect(nodes).toHaveLength(1);
      expect(nodes[0].text).toBe(
        action === 'remember' ? commandFact : commandFact.replace('CHF', 'EUR'),
      );
      if (action === 'update') {
        expect(nodes[0].confidence).toBe('confirmed');
        expect(
          nodes[0].sources.some((source: { excerpt: string }) => source.excerpt === 'EUR'),
        ).toBe(true);
      }
    }
  }
});

test('fills Brain from a saved historical chat through the workspace and resumes without duplicates', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const historyFact = 'Projekt Morgenrot verwendet einen festen Freigabeprozess mit zwei Personen.';
  await page.goto('/c/new');
  expect((await api(page, 'PATCH', '/api/memories/preferences', { memories: false })).status).toBe(
    200,
  );
  await page.reload();
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessage(page, historyFact);
  await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[a-f0-9-]{36}$/);
  const sourceId = page.url().split('/').at(-1);
  expect((await api(page, 'GET', '/api/brain/graph?query=Morgenrot')).body.nodes).toHaveLength(0);
  expect((await api(page, 'PATCH', '/api/memories/preferences', { memories: true })).status).toBe(
    200,
  );
  await page.reload();
  await page.getByTestId('nav-panel-brain').click();
  await page.getByRole('button', { name: 'Explore Brain' }).click();
  const workspace = page.getByTestId('brain-workspace');
  await workspace.getByTestId('brain-history-open').click();
  await expect(workspace.getByTestId('brain-history-panel')).toBeVisible();
  await workspace.getByTestId('brain-history-start').click();
  await expect
    .poll(async () => (await api(page, 'GET', '/api/brain/history')).body.status, {
      timeout: 120000,
    })
    .toBe('completed');
  const nodes = (await api(page, 'GET', '/api/brain/graph?query=Morgenrot')).body.nodes;
  expect(nodes).toHaveLength(1);
  expect(nodes[0].text).toBe(historyFact);
  expect(
    nodes[0].sources.some(
      (source: { conversationId: string }) => source.conversationId === sourceId,
    ),
  ).toBe(true);
  await expect(workspace.getByTestId('brain-history-panel')).toContainText('completed', {
    ignoreCase: true,
  });
  await page.screenshot({
    path: testInfo.outputPath('brain-history-completed.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const completed = (await api(page, 'GET', '/api/brain/history')).body;
  expect(completed.processed).toBe(completed.total);
  await api(page, 'POST', '/api/brain/history', {});
  await expect
    .poll(async () => (await api(page, 'GET', '/api/brain/history')).body.status, {
      timeout: 30000,
    })
    .toBe('completed');
  expect((await api(page, 'GET', '/api/brain/graph?query=Morgenrot')).body.nodes).toHaveLength(1);
  await api(page, 'DELETE', '/api/convos', { arg: { conversationId: sourceId } });
  expect((await api(page, 'GET', '/api/brain/graph?query=Morgenrot')).body.nodes).toHaveLength(0);
});
