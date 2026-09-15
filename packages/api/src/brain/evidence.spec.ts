import type { BrainCandidate } from './session';
import { validateContextualFacts } from './evidence';
import { conversationMessages } from './conversation';

const messages = conversationMessages([
  {
    messageId: 'source',
    conversationId: 'chat',
    isCreatedByUser: true,
    createdAt: new Date('2026-09-14T12:00:00Z'),
    text: 'Für Projekt Atlas benötigen Änderungen eine Freigabe.',
  },
]);
const fact: BrainCandidate = {
  text: messages[0].text,
  quote: messages[0].text,
  title: 'Freigabe für Atlas',
  kind: 'decision',
  scope: 'Projekt Atlas',
  basis: 'direct',
  claimState: 'agreed',
  evidence: [{ messageId: 'source', quote: messages[0].text }],
};

describe('contextual candidate storage contract', () => {
  it('normalizes empty optional metadata before replaying a saved review', () => {
    const [valid] = validateContextualFacts(
      [{ ...fact, tags: ['', '  ', ' Atlas ', 'Atlas'], supersedesId: '' }],
      messages,
    );
    expect(valid).toMatchObject({
      text: fact.text,
      evidence: fact.evidence,
      tags: [' Atlas ', 'Atlas'],
    });
    expect(valid.supersedesId).toBeUndefined();
  });

  it('repairs a blank display title without changing the actual claim or evidence', () => {
    const [valid] = validateContextualFacts([{ ...fact, title: '   ' }], messages);
    expect(valid.title).toBe(fact.text);
    expect(valid.evidence).toEqual(fact.evidence);
  });

  it('compares actual timestamps before storing a validity range', () => {
    expect(
      validateContextualFacts(
        [{ ...fact, validFrom: '2026-09-15T00:00:00.9Z', validUntil: '2026-09-15T00:00:00Z' }],
        messages,
      ),
    ).toEqual([]);
    const [valid] = validateContextualFacts(
      [{ ...fact, validFrom: '2026-09-15T00:00:00Z', validUntil: '2026-09-15T00:00:00.9Z' }],
      messages,
    );
    expect(valid).toMatchObject({
      validFrom: '2026-09-15T00:00:00Z',
      validUntil: '2026-09-15T00:00:00.9Z',
    });
  });

  it('preserves service-valid wire values for request replay across an update', () => {
    for (const original of [
      fact,
      {
        ...fact,
        title: undefined,
        tags: [' Atlas ', 'Atlas'],
        scope: '',
        validFrom: '2026-09-15T00:00:00Z',
      },
    ]) {
      const [valid] = validateContextualFacts([original], messages);
      expect(JSON.stringify(valid)).toBe(JSON.stringify(original));
    }
  });

  it('normalizes oversized date representations without dropping time qualification', () => {
    const [valid] = validateContextualFacts(
      [{ ...fact, validFrom: `2026-09-15T00:00:00.${'0'.repeat(40)}Z` }],
      messages,
    );
    expect(valid.validFrom).toBe('2026-09-15T00:00:00.000Z');
    expect(validateContextualFacts([{ ...fact, validFrom: 'not-a-date' }], messages)).toEqual([]);
  });

  it('excludes invalid control characters without modifying exact source text', () => {
    expect(validateContextualFacts([{ ...fact, tags: ['Atlas\0'] }], messages)).toEqual([]);
    expect(
      validateContextualFacts([fact], [{ ...messages[0], text: `${messages[0].text}\0` }]),
    ).toEqual([]);
  });

  it('rejects whitespace-only evidence and content instead of sending an invalid fact', () => {
    expect(validateContextualFacts([{ ...fact, text: ' '.repeat(20) }], messages)).toEqual([]);
    const blank = { ...messages[0], text: 'Ein Vorschlag.   Dann geht es weiter.' };
    expect(
      validateContextualFacts(
        [{ ...fact, evidence: [{ messageId: 'source', quote: '   ' }] }],
        [blank],
      ),
    ).toEqual([]);
  });
});
