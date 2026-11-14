import { hasAuthoredBrainSupport } from './evidence';
import { createBrainSession } from './session';
import { conversationMessages } from './conversation';
import type { BrainCandidate } from './session';

const flag = process.env.KISUNO_CWV01_SAFE_WORK;
beforeEach(() => {
  process.env.KISUNO_CWV01_SAFE_WORK = 'true';
});
afterAll(() => {
  if (flag == null) delete process.env.KISUNO_CWV01_SAFE_WORK;
  else process.env.KISUNO_CWV01_SAFE_WORK = flag;
});
it('does not promote a generic memory command into proof of an invented technical field', () => {
  const messages = conversationMessages([
    {
      messageId: 'user',
      conversationId: 'chat',
      isCreatedByUser: true,
      createdAt: new Date(),
      text: 'merke in brain wie man titel hinterlegt in odoo',
    },
  ]);
  const fact: BrainCandidate = {
    quote: messages[0].text,
    text: 'Der Titel wird in client_order_ref hinterlegt.',
    kind: 'procedure',
    evidence: [{ messageId: 'user', quote: messages[0].text }],
  };
  expect(hasAuthoredBrainSupport(fact, messages)).toBe(false);
});
it('accepts a concrete authored correction with its actual technical field', () => {
  const text = 'Der Titel steht im Custom Field title und nicht in client_order_ref.';
  const messages = conversationMessages([
    {
      messageId: 'user',
      conversationId: 'chat',
      isCreatedByUser: true,
      createdAt: new Date(),
      text,
    },
  ]);
  expect(
    hasAuthoredBrainSupport(
      { quote: text, text, kind: 'procedure', evidence: [{ messageId: 'user', quote: text }] },
      messages,
    ),
  ).toBe(true);
});
it('defers automatic Brain retrieval and blocks searching before skill selection', async () => {
  const session = createBrainSession({
    userId: 'user',
    conversationId: 'chat',
    messageId: 'reply',
    source: {
      id: 'user-message',
      text: 'Validiere die Tickets gemäss Skill',
      createdAt: new Date().toISOString(),
    },
    contextBudgetTokens: 3000,
    canWrite: true,
    canUpdate: true,
    skillFirst: true,
    hasLoadedSkill: () => false,
  });
  expect(await session.initialize()).toContain('nach dem passenden Skill');
  const search = session.tools.find((t) => t.name === 'brain_search')!;
  expect(
    await search.invoke({ query: 'Ticketprüfung', missingInformation: 'Fehlende Regel' }),
  ).toContain('zuerst den passenden Skill');
});
it('does not silently store an explicit skill-edit request in Brain', async () => {
  const session = createBrainSession({
    userId: 'user',
    conversationId: 'chat',
    messageId: 'reply',
    source: {
      id: 'source',
      text: 'Merke diesen Ablauf im Validierungs Skill.',
      createdAt: new Date().toISOString(),
    },
    contextBudgetTokens: 3000,
    canWrite: true,
    canUpdate: true,
    skillFirst: true,
  });
  expect(
    await session.remember([
      { quote: 'Merke diesen Ablauf im Validierungs Skill.', kind: 'procedure' },
    ]),
  ).toMatchObject({ nodes: [], skipped: 1, error: expect.stringContaining('Skill-Anpassung') });
});
