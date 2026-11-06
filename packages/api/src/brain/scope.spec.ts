import { ownBrainOrganizations, withoutOwnBrainScope, isOwnBrainOrganizationScope } from './scope';

const reproduction =
  'Ich bin Projektleiter bei der Muster Haustechnik AG in Zug. Kundenbriefe schreibe ich immer in der Sie-Form, ohne Aufzählungszeichen, und schliesse mit «Freundliche Grüsse, Team Muster Haustechnik». Unser Stundensatz für Service-Einsätze beträgt 145 CHF exkl. MWST. Bitte merke dir das dauerhaft für künftige Aufträge.';

describe('own organisation scope', () => {
  it('recognises the own employer introduced in the message', () => {
    const organizations = ownBrainOrganizations([reproduction]);
    expect(organizations).toEqual(['muster haustechnik']);
    for (const scope of ['Muster Haustechnik AG', 'Muster Haustechnik', 'muster haustechnik ag']) {
      expect(isOwnBrainOrganizationScope(scope, organizations)).toBe(true);
    }
    expect(isOwnBrainOrganizationScope('Bäckerei Huber', organizations)).toBe(false);
    expect(isOwnBrainOrganizationScope('Projekt Atlas', organizations)).toBe(false);
  });

  it.each([
    ['Unsere Firma heisst Alpha Treuhand GmbH.', 'alpha treuhand'],
    ['Ich arbeite bei der Gemeinde Baar und schreibe Protokolle.', 'gemeinde baar'],
    ['Ich bin Leiterin Technik bei Beta Systems AG. Kundenbriefe sind kurz.', 'beta systems'],
    ['Wir sind die Praxis Lehmann in Bern.', 'praxis lehmann'],
    ['I work at Contoso Ltd. We answer in English.', 'contoso'],
  ])('reads the own organisation in %s', (text, expected) => {
    expect(ownBrainOrganizations([text])).toEqual([expected]);
  });

  it.each([
    'Ich bin morgen bei Meier & Söhne für die Wartung.',
    'Ich arbeite heute bei Kunde Huber an der Firewall.',
    'Ich bin Kunde bei der Raiffeisenbank Zug.',
    'Ich arbeite für die Bäckerei Huber an einer neuen Website.',
    'Wir sind morgen bei der Keller GmbH.',
  ])('does not treat a customer or visit as the own organisation: %s', (text) => {
    expect(ownBrainOrganizations([text])).toEqual([]);
  });

  it('removes only a scope that names the own organisation', () => {
    const organizations = ownBrainOrganizations([reproduction]);
    const result = withoutOwnBrainScope(
      [
        {
          quote: 'Kundenbriefe schreibe ich immer in der Sie-Form',
          scope: 'Muster Haustechnik AG',
        },
        { quote: 'Für die Bäckerei Huber gilt Lieferung am Montag.', scope: 'Bäckerei Huber' },
        { quote: 'Ohne Bereich bleibt ohne Bereich.' },
      ],
      organizations,
    );
    expect(result.map((candidate) => candidate.scope)).toEqual([
      undefined,
      'Bäckerei Huber',
      undefined,
    ]);
    expect(withoutOwnBrainScope([{ scope: 'Muster Haustechnik AG' }], [])).toEqual([
      { scope: 'Muster Haustechnik AG' },
    ]);
  });
});
