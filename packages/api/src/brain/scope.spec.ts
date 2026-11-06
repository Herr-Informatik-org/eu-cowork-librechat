import { ownBrainOrganizations, withoutOwnBrainScope, isOwnBrainOrganizationScope } from './scope';

const reproduction =
  'Ich bin Projektleiter bei der Muster Haustechnik AG in Zug. Kundenbriefe schreibe ich immer in der Sie-Form, ohne Aufzählungszeichen, und schliesse mit «Freundliche Grüsse, Team Muster Haustechnik». Unser Stundensatz für Service-Einsätze beträgt 145 CHF exkl. MWST. Bitte merke dir das dauerhaft für künftige Aufträge.';

describe('own organisation scope', () => {
  it('recognises the own employer named with a legal form in the role statement', () => {
    const organizations = ownBrainOrganizations(reproduction);
    expect(organizations).toEqual(['muster haustechnik']);
    for (const scope of ['Muster Haustechnik AG', 'Muster Haustechnik', 'muster haustechnik ag']) {
      expect(isOwnBrainOrganizationScope(scope, organizations)).toBe(true);
    }
    expect(isOwnBrainOrganizationScope('Bäckerei Huber', organizations)).toBe(false);
  });

  it.each([
    ['Ich arbeite bei Swisscom.', 'swisscom'],
    ['Ich arbeite als Projektleiterin bei der Gemeinde Baar.', 'gemeinde baar'],
    ['Ich bin bei der Gemeinde Baar angestellt.', 'gemeinde baar'],
    ['Mein Arbeitgeber ist die Praxis Lehmann.', 'praxis lehmann'],
    ['Unsere Firma heisst Alpha Treuhand GmbH.', 'alpha treuhand'],
    ['Wir sind die Beta Systems AG.', 'beta systems'],
    ['I work at Contoso Ltd. We answer in English.', 'contoso'],
  ])('reads the explicit self-statement %s', (text, expected) => {
    expect(ownBrainOrganizations(text)).toEqual([expected]);
  });

  it.each([
    'Wir sind Schweizer und schreiben ss statt ß.',
    'Ich bin Projektleiter bei Swisscom.',
    'Ich bin Berater bei der Keller AG.',
    'Ich bin morgen bei Meier & Söhne für die Wartung.',
    'Ich arbeite heute bei Kunde Huber an der Firewall.',
    'Ich bin Kunde bei der Raiffeisenbank Zug AG.',
    'Ich arbeite für die Bäckerei Huber an einer neuen Website.',
    'Unsere Firma ist Kunde der Keller AG.',
    'Der Kunde schreibt «wir sind die Bäckerei Meier AG» und fragt nach dem Preis.',
    'Bitte beantworte diese Mail.\nGuten Tag Herr Muster\nwir sind die Bäckerei Meier AG und brauchen eine Offerte.',
    'Bitte kurz antworten.\nVon: info@baeckerei-meier.ch\nBetreff: Anfrage\nWir sind die Bäckerei Meier AG.',
    'Antwort bitte freundlich.\n> Wir sind die Bäckerei Meier AG.',
    '[KONTEXT: Mail]\nWir sind die Bäckerei Meier AG.\n[/KONTEXT]\nBitte zusammenfassen.',
  ])(
    'does not treat a visit, customer, nationality or pasted text as the own employer: %s',
    (text) => {
      expect(ownBrainOrganizations(text)).toEqual([]);
    },
  );

  it('compares by exact normalized name only, never by containment', () => {
    expect(isOwnBrainOrganizationScope('Kanton Bern Projekt', ['bern'])).toBe(false);
    expect(isOwnBrainOrganizationScope('Informatik', ['herr informatik'])).toBe(false);
    expect(isOwnBrainOrganizationScope('Herr Informatik AG', ['herr informatik'])).toBe(true);
  });

  it('removes only a scope that names the own organisation', () => {
    const organizations = ownBrainOrganizations(reproduction);
    const result = withoutOwnBrainScope(
      [
        {
          quote: 'Kundenbriefe schreibe ich immer in der Sie-Form',
          scope: 'Muster Haustechnik AG',
        },
        { quote: 'Für die Bäckerei Huber gilt Lieferung am Montag.', scope: 'Bäckerei Huber' },
        {
          quote: 'Für die Muster Haustechnik Zug gilt etwas anderes.',
          scope: 'Muster Haustechnik Zug',
        },
        { quote: 'Ohne Bereich bleibt ohne Bereich.' },
      ],
      organizations,
    );
    expect(result.map((candidate) => candidate.scope)).toEqual([
      undefined,
      'Bäckerei Huber',
      'Muster Haustechnik Zug',
      undefined,
    ]);
    expect(withoutOwnBrainScope([{ scope: 'Muster Haustechnik AG' }], [])).toEqual([
      { scope: 'Muster Haustechnik AG' },
    ]);
  });
});
