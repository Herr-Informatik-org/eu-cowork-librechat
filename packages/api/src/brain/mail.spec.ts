import type { ServerRequest } from '~/types';
import type { BrainNode } from 'librechat-data-provider';
import { readPersonalMailContext, rememberPersonalMailRule } from './mail';
import { checkAccess } from '~/middleware/access';
import { requestBrain } from './client';
jest.mock('~/middleware/access', () => ({ checkAccess: jest.fn(async () => true) }));
jest.mock('~/utils/tokenizer', () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
}));
jest.mock('./client', () => ({ requestBrain: jest.fn(), isBrainConfigured: () => true }));
const fetchBrain = jest.mocked(requestBrain);
const req = () =>
  ({
    user: { id: 'owner', personalization: { memories: true } },
    config: { memory: {} },
  }) as ServerRequest;
const roles = jest.fn();
const node = (id: string, scope: string | null) =>
  ({
    id,
    kind: 'preference',
    text: 'Bitte Antworten immer kurz halten.',
    scope,
    sources: [],
    confidence: 'confirmed',
  }) as unknown as BrainNode;
beforeEach(() => {
  fetchBrain.mockReset();
  jest.mocked(checkAccess).mockResolvedValue(true);
});
it('does not retrieve or write when personal memory is off', async () => {
  const request = req();
  request.user!.personalization!.memories = false;
  expect(
    await readPersonalMailContext(request, roles, { query: 'Mail', sender: 'test@example.com' }),
  ).toEqual({ context: '', status: 'disabled', count: 0 });
  await expect(
    rememberPersonalMailRule(request, roles, {
      text: 'Bitte immer kurz antworten.',
      scope: 'global',
      sender: 'test@example.com',
    }),
  ).rejects.toThrow();
  expect(fetchBrain).not.toHaveBeenCalled();
});
it('loads contact and mail rules before general context, excluding another contact', async () => {
  fetchBrain.mockResolvedValue({
    nodes: [
      node('contact', 'Mail: a@example.com'),
      node('mail', 'Mail'),
      node('wrong', 'Mail: b@example.com'),
      { ...node('project', 'Other project'), kind: 'project' },
      node('personal', null),
    ],
  });
  const result = await readPersonalMailContext(req(), roles, {
    query: 'Eine beliebige Nachricht',
    sender: 'A@example.com',
  });
  expect(result.count).toBe(4);
  expect(result.context).not.toContain('"wrong"');
  expect(fetchBrain).toHaveBeenCalledTimes(1);
  expect(fetchBrain.mock.calls[0][3]).toMatchObject({
    purpose: 'mail',
    applicableScopes: ['Mail: a@example.com', 'Mail'],
    recordTrace: false,
  });
  expect(result.items?.map((item) => item.id)).toEqual(['contact', 'mail', 'project', 'personal']);
  expect(fetchBrain.mock.calls.every((call) => call[0] === 'owner')).toBe(true);
});
it('respects the callers actual context budget without fragmenting a rule', async () => {
  fetchBrain.mockResolvedValue({
    nodes: [node('one', 'Mail'), node('two', 'Mail'), node('three', 'Mail')],
  });
  const result = await readPersonalMailContext(req(), roles, {
    query: 'Mail',
    sender: 'a@example.com',
    contextBudgetTokens: 128,
  });
  expect(Math.ceil(result.context.length / 4)).toBeLessThanOrEqual(128);
  expect(result.context.split('\n').every((line) => JSON.parse(line))).toBe(true);
});
it('saves only the explicit authored rule using the signed owner and selected contact scope', async () => {
  fetchBrain.mockResolvedValue({ node: node('saved', 'Mail: a@example.com') });
  await rememberPersonalMailRule(req(), roles, {
    text: 'Bitte Antworten immer kurz halten.',
    scope: 'sender',
    sender: 'A@example.com',
  });
  expect(fetchBrain).toHaveBeenCalledWith(
    'owner',
    'POST',
    '/v1/nodes',
    expect.objectContaining({
      kind: 'preference',
      scope: 'Mail: a@example.com',
      text: 'Bitte Antworten immer kurz halten.',
    }),
  );
});
it('degrades explicitly on service failures instead of claiming no preferences exist', async () => {
  fetchBrain.mockRejectedValue(new Error('offline'));
  expect(
    (await readPersonalMailContext(req(), roles, { query: 'Mail', sender: 'a@example.com' }))
      .status,
  ).toBe('unavailable');
});
it('preserves dates so the model can resolve explicitly changed rules within the same scope', async () => {
  fetchBrain.mockResolvedValue({
    nodes: [
      {
        ...node('latest', 'Mail'),
        createdAt: '2026-10-01T12:00:00Z',
        updatedAt: '2026-10-27T12:00:00Z',
      },
    ],
  });
  const result = await readPersonalMailContext(req(), roles, {
    query: 'Antwortstil',
    sender: 'a@example.com',
  });
  expect(JSON.parse(result.context)).toMatchObject({
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-27T12:00:00Z',
  });
});
