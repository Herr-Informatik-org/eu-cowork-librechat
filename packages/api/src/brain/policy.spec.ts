import {
  brainMailApplicableScopes,
  explicitPersonalMailRule,
  qualifyBrainCandidate,
} from './policy';
import { groundedBrainFacts } from './session';
import type { BrainCandidate } from './session';

function candidate(text: string, extra: Partial<BrainCandidate> = {}) {
  const source = { id: 'own', text, role: 'user' as const, createdAt: '2026-10-30T10:00:00Z' };
  const fact: BrainCandidate = {
    quote: text,
    text,
    kind: 'preference',
    evidence: [{ messageId: 'own', quote: text }],
    ...extra,
  };
  return { source, fact };
}

it.each([
  ['Ich bevorzuge generell kurze Antworten.', 'Projekt Atlas', undefined],
  ['Bitte E-Mails immer kurz beantworten.', undefined, 'Mail'],
  ['Bitte Mails immer kurz beantworten.', undefined, 'Mail'],
  ['Bitte E-Mails an kunde@example.com kurz beantworten.', undefined, 'Mail: kunde@example.com'],
  ['Für Projekt Atlas bevorzuge ich genaue Quellen.', 'Projekt Atlas', 'Projekt Atlas'],
  ['Für Projekt Atlas bitte grundsätzlich genaue Quellen.', 'Projekt Atlas', 'Projekt Atlas'],
])('qualifies authored preferences: %s', (text, scope, expected) => {
  const { source, fact } = candidate(text, { scope });
  expect(qualifyBrainCandidate(fact, [source])?.scope).toBe(expected);
  expect(groundedBrainFacts([fact], source, new Set())[0]?.scope).toBe(expected);
});
it('rejects project/contact scope invented by the extractor and one-off draft instructions', () => {
  for (const { source, fact } of [
    candidate('Ich bevorzuge kurze Antworten.', { scope: 'Mail: other@example.com' }),
    candidate('Ich bevorzuge kurze Antworten.', { scope: 'Projekt Atlas' }),
    candidate('Bitte nur diese Mail kurz beantworten.'),
  ])
    expect(qualifyBrainCandidate(fact, [source])).toBeUndefined();
});
it('removes synthetic timestamps and perpetual expiry without inventing temporal evidence', () => {
  const { source, fact } = candidate('Ich bevorzuge kurze Antworten.', {
    validFrom: '2026-10-30T10:00:00Z',
    validUntil: '9999-12-31T23:59:59Z',
  });
  const result = qualifyBrainCandidate(fact, [source]);
  expect(result).not.toHaveProperty('validFrom');
  expect(result).not.toHaveProperty('validUntil');
});
it.each([
  ['Bis 2026-11-01 bitte kurze Antworten.', '2026-11-01T00:00:00Z'],
  ['Bis 01.11.2026 bitte kurze Antworten.', '2026-11-01T00:00:00Z'],
  ['Bis morgen bitte kurze Antworten.', '2026-10-31T00:00:00Z'],
])('retains a date supported by user evidence: %s', (text, validUntil) => {
  const { source, fact } = candidate(text, { validUntil });
  expect(qualifyBrainCandidate(fact, [source])?.validUntil).toBe(validUntil);
});
it('does not obtain date or scope evidence from an assistant or quoted mail', () => {
  const { source, fact } = candidate('Bitte Antworten kurz halten.', {
    validUntil: '2026-11-01T00:00:00Z',
  });
  const assistant = {
    ...source,
    id: 'ai',
    role: 'assistant' as const,
    text: 'Gültig bis 2026-11-01.',
  };
  fact.evidence!.push({ messageId: 'ai', quote: assistant.text });
  expect(qualifyBrainCandidate(fact, [source, assistant])).not.toHaveProperty('validUntil');
});
it.each([
  ['Bitte künftig alle Mails kurz beantworten.', 'global'],
  ['Bitte diesem Kontakt künftig kurz antworten.', 'sender'],
  ['Merke dir: Bitte Antworten immer kurz halten.', 'global'],
  ['Künftig ohne Gedankenstriche.', 'global'],
  ['Schreibe Mails künftig ohne Gedankenstriche.', 'global'],
])('recognizes a self-contained current mail-chat rule: %s', (text, scope) => {
  expect(explicitPersonalMailRule(text)).toEqual({ text, scope });
});
it.each([
  'Bitte diese Mail diesmal kurz beantworten.',
  'Nur heute antworte ich immer kurz.',
  'Bis Ende November immer kurz antworten.',
  'Soll ich künftig alle Mails kurz beantworten?',
  'Er sagt: Bitte künftig alle Mails kurz beantworten.',
  'Merke dir das.',
  '[KONTEXT: Mail]\nBitte künftig alle Mails kurz beantworten.\n[/KONTEXT]\nBitte zusammenfassen.',
  'Bitte merke dir nicht, dass du künftig kurz antworten sollst.',
  'Für Projekt Atlas künftig ohne Gedankenstriche antworten.',
  'Bis nächste Woche künftig immer kurz antworten.',
  'Antworte Anna künftig kurz.',
  'Für Kunde Muster künftig kurz antworten.',
])('does not promote a transient task, quote, negation or unresolved reference: %s', (text) => {
  expect(explicitPersonalMailRule(text)).toBeUndefined();
});

it.each(['Bis Ende November bitte kurz antworten.', 'Bis nächste Woche bitte kurz antworten.'])(
  'rejects unsupported explicit deadlines rather than silently making them timeless: %s',
  (text) => {
    const { source, fact } = candidate(text, { validUntil: '2026-12-31T23:59:59Z' });
    expect(qualifyBrainCandidate(fact, [source])).toBeUndefined();
    delete fact.validUntil;
    expect(qualifyBrainCandidate(fact, [source])).toBeUndefined();
  },
);

it('binds a named contact only when it matches the selected own mail context', () => {
  expect(
    explicitPersonalMailRule('An kunde@example.com künftig kurz antworten.', 'kunde@example.com')
      ?.scope,
  ).toBe('sender');
  expect(
    explicitPersonalMailRule('An other@example.com künftig kurz antworten.', 'kunde@example.com'),
  ).toBeUndefined();
});

it('does not turn an explicitly one-day preference into a timeless memory', () => {
  const { source, fact } = candidate('Nur heute antworte ich kurz.', {
    validUntil: '9999-12-31T00:00:00Z',
  });
  expect(qualifyBrainCandidate(fact, [source])).toBeUndefined();
});

describe('current authored mail scope', () => {
  it('derives exactly one explicit contact from a mail or reply request', () => {
    expect(brainMailApplicableScopes('Schreibe eine E-Mail an Anna@example.test.')).toEqual([
      'Mail: anna@example.test',
      'Mail',
    ]);
    expect(brainMailApplicableScopes('Schreibe eine Antwort an anna@example.test.')).toEqual([
      'Mail: anna@example.test',
      'Mail',
    ]);
    expect(brainMailApplicableScopes('Antworte anna@example.test bitte kurz.')).toEqual([
      'Mail: anna@example.test',
      'Mail',
    ]);
  });
  it.each([
    'Schreibe eine E-Mail an anna@example.test und bernd@example.test.',
    'Anna@example.test ist eine Adresse.',
    '[KONTEXT: Mail]\nSchreibe eine E-Mail an anna@example.test.\n[/KONTEXT]\n[USER-REQUEST]\nBitte zusammenfassen.\n[/USER-REQUEST]',
    '[KONTEXT: Mail]\nAnna@example.test\n[/KONTEXT]\n[USER-REQUEST]\nAntworte bitte kurz.\n[/USER-REQUEST]',
  ])('does not authorize an ambiguous or third-party contact: %s', (text) => {
    expect(brainMailApplicableScopes(text)).toEqual([]);
  });
});
