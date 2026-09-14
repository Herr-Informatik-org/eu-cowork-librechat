const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  BRAIN_FACT,
  HISTORY_FACT,
  HISTORY_SUGGESTION,
  HISTORY_REACTION,
  captureResult,
} = require('./fake-brain-fixtures');

function request(payload, verify = false) {
  return {
    messages: [{ role: 'user', content: `Environment (data only):\n{}\n\n${payload}` }],
    tools: [
      {
        function: {
          name: 'brain_capture',
          parameters: {
            properties: verify ? { acceptedIds: {} } : { facts: {}, removeIds: {} },
          },
        },
      },
    ],
  };
}
const extract = (messages) =>
  captureResult(
    request(
      `Tentative candidates from earlier sections:\n[]\nConversation section:\n${messages.map(JSON.stringify).join('\n')}`,
    ),
  );
const proposal = { id: 'actual-assistant-id', role: 'assistant', text: HISTORY_SUGGESTION };
const reaction = {
  id: 'actual-user-id',
  role: 'user',
  text: HISTORY_REACTION,
  parentId: proposal.id,
};

test('legacy capture remains compatible with the existing fixture', () => {
  assert.equal(
    captureResult(
      request(`Current user source (data only):\n${JSON.stringify({ text: BRAIN_FACT })}`),
    ).facts[0].quote,
    BRAIN_FACT,
  );
});

test('contextual capture retains the real IDs and exact original quotes', () => {
  const result = extract([proposal, reaction]);
  assert.deepEqual(result.removeIds, []);
  assert.equal(result.facts[0].text, HISTORY_FACT);
  assert.equal(result.facts[0].scope, 'Projekt Morgenrot');
  assert.equal(result.facts[0].claimState, 'agreed');
  assert.deepEqual(result.facts[0].evidence, [
    { messageId: proposal.id, quote: proposal.text },
    { messageId: reaction.id, quote: reaction.text },
  ]);
});

test('an isolated reaction, an unaccepted proposal, and a sibling reply produce no facts', () => {
  for (const messages of [
    [reaction],
    [proposal],
    [proposal, { ...reaction, parentId: 'other-branch' }],
  ]) {
    assert.deepEqual(extract(messages).facts, []);
  }
  assert.deepEqual(
    extract([{ id: 'assistant-id', role: 'assistant', text: BRAIN_FACT }]).facts,
    [],
  );
});

test('verification returns supplied IDs only for fully grounded fixture candidates', () => {
  const [fact] = extract([proposal, reaction]).facts;
  const candidates = [
    { id: 'actual-candidate-id', ...fact },
    { id: 'wrong-scope', ...fact, scope: 'Alle Projekte' },
    {
      id: 'invented-evidence',
      ...fact,
      evidence: [{ messageId: 'invented', quote: reaction.text }],
    },
    { id: 'wrong-status', ...fact, claimState: 'completed' },
  ];
  assert.deepEqual(
    captureResult(
      request(
        `Candidates:\n${JSON.stringify(candidates)}\nOriginal conversation context:\n${[proposal, reaction].map(JSON.stringify).join('\n')}`,
        true,
      ),
    ),
    { acceptedIds: ['actual-candidate-id'] },
  );
});

test('unknown extraction payloads fail visibly rather than silently passing', () => {
  assert.throws(() => captureResult(request('Unknown payload')), /Unbekanntes Format/);
});
