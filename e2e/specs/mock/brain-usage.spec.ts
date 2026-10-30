import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {
  BrainNode,
  BrainQuality,
  BrainRecall,
  BrainRebuildStatus,
  BrainUsage,
  MailWorkspaceContent,
  MailWorkspaceResult,
  MailWorkspaceStatus,
} from 'librechat-data-provider';
import { withMongo } from './db';
import {
  messagesView,
  MOCK_ENDPOINTS,
  mockReply,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

test.setTimeout(60_000);

const node: BrainNode = {
  id: 'brain-ui-fixture',
  title: 'Persönlicher Antwortstil',
  text: 'Antworten bitte knapp auf Deutsch.',
  kind: 'preference',
  scope: null,
  tags: [],
  status: 'active',
  confidence: 'confirmed',
  basis: 'confirmed',
  pinned: false,
  version: 1,
  createdAt: '2026-10-30T08:00:00Z',
  updatedAt: '2026-10-30T08:00:00Z',
  sources: [
    {
      id: 'source-fixture',
      type: 'manual',
      label: 'Eigene Regel',
      excerpt: 'Meine Vorliebe',
      createdAt: '2026-10-30T08:00:00Z',
    },
  ],
};
const usage = (text: string): BrainUsage => ({
  status: 'available',
  count: 1,
  items: [
    {
      id: node.id,
      title: node.title,
      text,
      kind: node.kind,
      scope: node.scope,
      status: 'active',
      basis: 'confirmed',
      validFrom: '2026-10-01T00:00:00Z',
      validUntil: '2026-12-01T00:00:00Z',
      updatedAt: node.updatedAt,
      sources: [{ type: 'manual' }],
    },
  ],
});
const quality: BrainQuality = {
  revision: 7,
  total: 2,
  truncated: false,
  findings: [
    {
      id: 'scope-fixture',
      nodeId: node.id,
      version: 1,
      reason: 'general_preference_scope',
      explanation: 'Eine ausdrücklich allgemeine Vorliebe trägt einen engen Kontaktbereich.',
      before: { ...node, scope: 'Mail: brain-kunde@example.test' },
      proposedChanges: { scope: null },
      reviewOnly: false,
    },
    {
      id: 'review-fixture',
      nodeId: 'review-node',
      version: 1,
      reason: 'duplicate_candidate',
      explanation: 'Die Bedeutung muss vor einer Zusammenlegung geprüft werden.',
      before: { ...node, id: 'review-node', title: 'Ähnliche Vorliebe' },
      reviewOnly: true,
    },
  ],
};
const shadow: BrainRebuildStatus = {
  rebuild: {
    id: 'shadow-fixture',
    status: 'ready',
    createdAt: node.createdAt,
    revision: 7,
    counts: { current: 2, staged: 2, preserved: 1, retired: 1 },
    preview: { added: [node], retired: [{ ...node, scope: 'Mail: brain-kunde@example.test' }] },
    previewTruncated: false,
  },
  rollbackAvailable: false,
};

async function brainFixture(page: Page) {
  const state = {
    messageId: '',
    conversationId: '',
    qualityReads: 0,
    applied: [] as Array<{ revision: number; findingIds: string[] }>,
    activated: 0,
    recallIds: [] as string[],
  };
  await page.route('**/api/brain/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/brain', '');
    if (path === '/recalls') {
      const requestedId = url.searchParams.get('messageId') ?? '';
      state.recallIds.push(requestedId);
      const recall = (messageId: string, text: string, provided = true): BrainRecall => ({
        id: `${messageId}-${text}`,
        conversationId: state.conversationId,
        messageId,
        nodeIds: [node.id],
        provided,
        items: usage(text).items,
        query: 'Synthetischer Auftrag',
        estimatedTokens: 40,
        hasMore: false,
        stopReason: 'complete',
        createdAt: node.createdAt,
      });
      await route.fulfill({
        json: {
          recalls: [
            recall('latest-other-response', 'Darf bei dieser Antwort nicht erscheinen.'),
            recall(state.messageId, 'Nur gesucht, nie bereitgestellt.', false),
            // The exact-message endpoint must be used even after more than twenty later recalls.
            ...(requestedId === state.messageId
              ? [recall(state.messageId, 'Für genau diese Chatantwort bereitgestellt.')]
              : []),
          ],
        },
      });
      return;
    }
    if (path === '/quality') {
      state.qualityReads++;
      await route.fulfill({ json: quality });
      return;
    }
    if (path === '/quality/apply') {
      state.applied.push(route.request().postDataJSON());
      await route.fulfill({ json: shadow });
      return;
    }
    if (path.includes('/activate')) {
      state.activated++;
      await route.fulfill({ json: { rebuild: null, rollbackAvailable: true } });
      return;
    }
    const data = {
      '/status': { enabled: true },
      '/graph': { nodes: [node], edges: [], total: 1, nextCursor: null },
      [`/nodes/${node.id}`]: { node, edges: [] },
      '/history': { available: true, status: 'idle', processed: 0, total: 0, saved: 0, skipped: 0 },
      '/rebuild': state.applied.length ? shadow : { rebuild: null, rollbackAvailable: false },
      '/learning': { status: 'idle' },
    };
    const body = data[path as keyof typeof data];
    await route.fulfill({
      status: body ? 200 : 404,
      json: body ?? { error: `Unerwarteter Brain-Testaufruf: ${path}` },
    });
  });
  return state;
}

test('shows context for the exact chat response and prepares selected quality changes without activating them', async ({
  page,
}, testInfo) => {
  const state = await brainFixture(page);
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessage(page, 'Synthetische Brain-UI-Prüfung. Bitte kurz antworten.');
  await expect(mockReply(page)).toBeVisible();
  await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/);
  state.conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect
    .poll(async () => {
      const message = await withMongo((db) =>
        db
          .collection('messages')
          .findOne({ conversationId: state.conversationId, isCreatedByUser: false }),
      );
      state.messageId = message?.messageId ?? '';
      return state.messageId;
    })
    .not.toBe('');
  const info = messagesView(page).getByRole('button', { name: 'Brain-Info', exact: true });
  await expect(info).toBeVisible();
  expect(state.recallIds).toEqual([]);
  await expect(page.getByText('Für genau diese Chatantwort bereitgestellt.')).not.toBeVisible();
  await info.click();
  await expect(
    page.getByText('Für genau diese Chatantwort bereitgestellt.', { exact: true }),
  ).toBeVisible();
  expect(state.recallIds).toContain(state.messageId);
  await expect(page.getByText('Darf bei dieser Antwort nicht erscheinen.')).not.toBeVisible();
  await expect(page.getByText('Nur gesucht, nie bereitgestellt.')).not.toBeVisible();
  await expect(page.getByText(/^(Gültig bis|Applies until)$/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('brain-chat-context.png') });
  await page.getByRole('button', { name: 'Im Brain ansehen', exact: true }).click();
  const workspace = page.getByTestId('brain-workspace');
  await expect(workspace).toBeVisible();
  expect(state.qualityReads).toBe(0);
  await workspace.getByText('Wissen prüfen und bereinigen', { exact: true }).click();
  const qualitySection = workspace.locator('.brain-quality');
  const checkbox = qualitySection.getByRole('checkbox', { name: node.title, exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(qualitySection.getByRole('checkbox')).toHaveCount(1);
  await expect(qualitySection.getByText('Ähnliche Vorliebe', { exact: true })).toBeVisible();
  await expect(
    qualitySection.getByText('Mail: brain-kunde@example.test', { exact: true }),
  ).toBeVisible();
  expect(state.applied).toEqual([]);
  await checkbox.check();
  await page.screenshot({ path: testInfo.outputPath('brain-quality-selection.png') });
  await qualitySection
    .getByRole('button', { name: 'Auswahl vorbereiten (1)', exact: true })
    .click();
  await expect.poll(() => state.applied).toEqual([{ revision: 7, findingIds: ['scope-fixture'] }]);
  await expect(qualitySection).not.toHaveAttribute('open');
  await expect(
    workspace.getByRole('button', { name: 'Use new version', exact: true }),
  ).toBeVisible();
  expect(state.activated).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('brain-quality-shadow.png') });
});

async function mailFixture(page: Page) {
  const row: MailWorkspaceResult = {
    id: 'brain-mail-fixture',
    revision: 'mail-revision',
    subject: 'Synthetische Brain-Mail',
    sender: 'brain-kunde@example.test',
    receivedAt: '2026-10-30T08:00:00Z',
    priority: 'normal',
    action: 'reply',
    summary: 'Termin bestätigen.',
    reason: 'Rückfrage',
    questions: [],
    draftStatus: 'created',
    memory: usage('Für die Mailanalyse bereitgestellt.'),
  };
  const status: MailWorkspaceStatus = {
    available: true,
    modelLabel: 'Synthetisches Modell',
    connection: { connected: true, mailbox: 'brain-owner@example.test' },
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
      body: 'Bitte bestätige den Termin.',
      bodyTruncated: false,
    },
    draft: {
      subject: 'Re: Synthetische Brain-Mail',
      body: 'Langer synthetischer Entwurf.\nOriginalverlauf.',
      bodyTruncated: false,
      replyText: 'Langer synthetischer Entwurf.',
      revision: 'draft-revision',
      memory: usage('Für diesen Entwurf bereitgestellt.'),
    },
  };
  const state = {
    saved: [] as Array<{ body: string; revision: string }>,
    rules: [] as Array<{ text: string; scope: string }>,
    chats: 0,
  };
  await page.route('**/api/mail/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/mail', '');
    if (path === `/results/${row.id}/draft` && route.request().method() === 'PUT') {
      const request = route.request().postDataJSON();
      state.saved.push(request);
      content.draft = {
        ...content.draft!,
        replyText: request.body,
        body: `${request.body}\nOriginalverlauf.`,
        memory: undefined,
      };
      await route.fulfill({
        json: {
          ruleProposal: {
            text: 'Antworte diesem Kontakt künftig kurz und ohne Floskeln.',
            scope: 'sender',
          },
        },
      });
      return;
    }
    if (path === `/results/${row.id}/rule`) {
      state.rules.push(route.request().postDataJSON());
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === `/results/${row.id}/chat`) {
      state.chats++;
      await route.fulfill({
        json: {
          answer: 'Synthetischer Mailchat-Vorschlag.',
          memory: usage('Für diese Mailchat-Antwort bereitgestellt.'),
        },
      });
      return;
    }
    const responses = {
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
    const body = responses[path as keyof typeof responses];
    await route.fulfill({
      status: body ? 200 : 404,
      json: body ?? { error: `Unerwarteter Mail-Testaufruf: ${path}` },
    });
  });
  await page.goto('/mail');
  await page.getByRole('button', { name: /brain-kunde@example.test/ }).click();
  return state;
}

test('shows separate Mail context and only learns an edited draft proposal after explicit acceptance', async ({
  page,
}, testInfo) => {
  await brainFixture(page);
  const state = await mailFixture(page);
  await expect(page.getByText('Für die Mailanalyse bereitgestellt.')).not.toBeVisible();
  await page.locator('.mail-summary-heading').getByRole('button', { name: 'Brain-Info' }).click();
  await expect(
    page.getByText('Für die Mailanalyse bereitgestellt.', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Entwurf', exact: true }).click();
  await page.locator('.mail-body-actions').getByRole('button', { name: 'Brain-Info' }).click();
  await expect(page.getByText('Für diesen Entwurf bereitgestellt.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('brain-mail-draft-context.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Antwort bearbeiten', exact: true }).click();
  await page
    .getByRole('textbox', { name: /Hier bearbeitest du nur/ })
    .fill('Danke, der Termin passt.');
  await page.getByRole('button', { name: 'Entwurf in Outlook speichern', exact: true }).click();
  await expect.poll(() => state.saved.length).toBe(1);
  expect(state.rules).toEqual([]);
  await page
    .getByRole('button', { name: 'Änderung als persönliche Regel prüfen', exact: true })
    .click();
  expect(state.rules).toEqual([]);
  const rule = page.getByRole('textbox', { name: 'Meine persönliche Regel', exact: true });
  await expect(rule).toHaveValue('Antworte diesem Kontakt künftig kurz und ohne Floskeln.');
  await rule.fill('Antworte diesem Kontakt künftig mit höchstens drei Sätzen.');
  await page.screenshot({ path: testInfo.outputPath('brain-mail-rule-proposal.png') });
  await page.getByRole('button', { name: 'Persönliche Regel merken', exact: true }).click();
  await expect.poll(() => state.rules.length).toBe(1);
  expect(state.rules[0]).toMatchObject({
    text: 'Antworte diesem Kontakt künftig mit höchstens drei Sätzen.',
    scope: 'sender',
  });
  await page.getByRole('tab', { name: 'Chat zu dieser Mail', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Deine Frage oder gewünschte Anpassung', exact: true })
    .fill('Welche Punkte sind offen?');
  await page.getByRole('button', { name: 'Fragen', exact: true }).click();
  const answer = page.locator('article.mail-chat-message.assistant');
  await expect(answer).toContainText('Synthetischer Mailchat-Vorschlag.');
  await answer.getByRole('button', { name: 'Brain-Info' }).click();
  await expect(
    page.getByText('Für diese Mailchat-Antwort bereitgestellt.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Für die Mailanalyse bereitgestellt.', { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('brain-mail-chat-context.png') });
  expect(state.chats).toBe(1);
});
