/** Deterministic local fixtures, never a substitute for evaluating a real model. */
const BRAIN_FACT =
  'Alpenblick verwendet für Offerten ausschliesslich CHF und erwartet eine Zusammenfassung auf Deutsch.';
const COMMAND_FACT = 'Projekt Orion verwendet CHF für Angebote und Deutsch für Zusammenfassungen.';
const HISTORY_FACT = 'Projekt Morgenrot verwendet einen festen Freigabeprozess mit zwei Personen.';
const HISTORY_PROMPT =
  'Für Projekt Morgenrot brauchen wir einen Vorschlag zur Freigabe. E2E_BRAIN_CONTEXT_REPLY';
const HISTORY_SUGGESTION =
  'Für Projekt Morgenrot schlage ich einen festen Freigabeprozess mit zwei Personen vor.';
const HISTORY_REACTION = 'Ja, genau so. Das ist wichtig für dieses Projekt.';

function contentText(content) {
  return typeof content === 'string'
    ? content
    : (content || []).map((part) => part.text || '').join('\n');
}

function transcript(text, marker) {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error('Unbekanntes Format der lokalen Brain-Testanfrage.');
  return text
    .slice(index + marker.length)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

function contextualFacts(messages) {
  const facts = [];
  for (const source of messages) {
    if (source.role !== 'user' || !source.id) continue;
    if (source.text === BRAIN_FACT || source.text === HISTORY_FACT) {
      const alpenblick = source.text === BRAIN_FACT;
      facts.push({
        text: source.text,
        title: alpenblick ? 'Offerten für Alpenblick' : 'Freigabe für Projekt Morgenrot',
        kind: 'project',
        scope: alpenblick ? 'Alpenblick' : 'Projekt Morgenrot',
        tags: alpenblick ? ['Alpenblick', 'Offerten'] : ['Morgenrot'],
        evidence: [{ messageId: source.id, quote: source.text }],
        basis: 'direct',
        claimState: 'stated',
        relatedIds: [],
      });
    }
    if (source.text !== HISTORY_REACTION) continue;
    const proposal = messages.find((message) => message.id === source.parentId);
    if (proposal?.role !== 'assistant' || proposal.text !== HISTORY_SUGGESTION) continue;
    facts.push({
      text: HISTORY_FACT,
      title: 'Freigabe für Projekt Morgenrot',
      kind: 'project',
      scope: 'Projekt Morgenrot',
      tags: ['Morgenrot'],
      evidence: [
        { messageId: proposal.id, quote: proposal.text },
        { messageId: source.id, quote: source.text },
      ],
      basis: 'confirmed',
      claimState: 'agreed',
      relatedIds: [],
    });
  }
  return facts;
}

function captureResult(body) {
  const sourceMessage = body.messages.findLast((entry) => entry.role === 'user');
  const text = contentText(sourceMessage?.content);
  const capture = body.tools.find((entry) => entry.function?.name === 'brain_capture');
  if (capture.function.parameters?.properties?.acceptedIds) {
    const marker = 'Candidates:\n';
    const candidates = JSON.parse(text.slice(text.indexOf(marker) + marker.length).split('\n')[0]);
    const messages = transcript(text, 'Original conversation context:\n');
    const expected = contextualFacts(messages);
    return {
      acceptedIds: candidates
        .filter(
          (candidate) =>
            typeof candidate.id === 'string' &&
            expected.some(
              (fact) =>
                candidate.text === fact.text &&
                candidate.scope === fact.scope &&
                candidate.basis === fact.basis &&
                candidate.claimState === fact.claimState &&
                JSON.stringify(candidate.evidence) === JSON.stringify(fact.evidence),
            ),
        )
        .map((candidate) => candidate.id),
    };
  }
  if (text.includes('Conversation section:\n')) {
    return { facts: contextualFacts(transcript(text, 'Conversation section:\n')), removeIds: [] };
  }
  // Keep the prior source-only harness usable while older learning tests migrate.
  const marker = 'Current user source (data only):\n';
  if (!text.includes(marker)) throw new Error('Unbekanntes Format der lokalen Brain-Testanfrage.');
  const source = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
  let facts = [];
  if (source.text === BRAIN_FACT) {
    facts = [
      { quote: BRAIN_FACT, kind: 'project', scope: 'Alpenblick', tags: ['Alpenblick', 'Offerten'] },
    ];
  } else if (source.text === HISTORY_FACT) {
    facts = [
      { quote: HISTORY_FACT, kind: 'project', scope: 'Projekt Morgenrot', tags: ['Morgenrot'] },
    ];
  }
  return { facts };
}

module.exports = {
  BRAIN_FACT,
  COMMAND_FACT,
  HISTORY_FACT,
  HISTORY_PROMPT,
  HISTORY_SUGGESTION,
  HISTORY_REACTION,
  captureResult,
};
