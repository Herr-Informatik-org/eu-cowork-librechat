import {
  isValidAhv,
  isValidIban,
  isValidCardNumber,
  containsBrainCredential,
  containsBrainIdentifier,
  containsBrainHealthData,
  brainAutomaticWithholding,
} from './safety';

describe('Brain sensitivity detection', () => {
  it.each([
    'CH93 0076 2011 6238 5295 7',
    'CH9300762011623852957',
    'LI21 0881 0000 2324 013A A',
    'DE89 3704 0044 0532 0130 00',
  ])('accepts the check digits of IBAN %s', (iban) => {
    expect(isValidIban(iban)).toBe(true);
    expect(containsBrainIdentifier(`Zahlung bitte auf ${iban} überweisen.`)).toBe(true);
  });

  it.each([
    'CH93 0076 2011 6238 5295 8',
    'CH94 0076 2011 6238 5295 7',
    'DE89 3704 0044 0532 0130 01',
    'XX93 0076 2011 6238 5295 7',
  ])('rejects IBAN %s with a wrong checksum or unknown country', (iban) => {
    expect(isValidIban(iban)).toBe(false);
    expect(containsBrainIdentifier(`Konto ${iban}`)).toBe(false);
  });

  it('finds an IBAN followed by ordinary words', () => {
    expect(containsBrainIdentifier('IBAN CH93 0076 2011 6238 5295 7 und Referenz folgen.')).toBe(
      true,
    );
  });

  it.each(['756.9217.0769.85', '7569217076985', '756 9217 0769 85'])(
    'accepts the EAN-13 check digit of AHV %s',
    (ahv) => {
      expect(isValidAhv(ahv)).toBe(true);
      expect(containsBrainIdentifier(`AHV-Nummer ${ahv}`)).toBe(true);
    },
  );

  it.each(['756.9217.0769.84', '7569217076980', '757.9217.0769.85'])(
    'rejects AHV %s with a wrong check digit or prefix',
    (ahv) => {
      expect(isValidAhv(ahv)).toBe(false);
      expect(containsBrainIdentifier(`AHV-Nummer ${ahv}`)).toBe(false);
    },
  );

  it.each(['4111 1111 1111 1111', '5555-5555-5555-4444', '3782 822463 10005', '4012888888881881'])(
    'treats Luhn-valid card number %s as a credential',
    (card) => {
      expect(isValidCardNumber(card)).toBe(true);
      expect(containsBrainCredential(`Karte ${card}, gültig bis 12/28`)).toBe(true);
    },
  );

  it.each([
    '4111 1111 1111 1112',
    '1234 5678 9012 3456',
    '0000 0000 0000 0000',
    '4444444444444444',
  ])('does not treat %s as a card number', (number) => {
    expect(containsBrainCredential(`Bestellnummer ${number}`)).toBe(false);
  });

  it.each([
    'PW: Geheim123',
    'Das WLAN-Kennwort lautet Sommer2026!',
    'Mein Passwort ist Tr0ub4dor',
    'PIN 4711',
    'Der PIN-Code: 123456',
    'Le mot de passe: abc123',
    'password = hunter22',
    'Bearer abcdefghijklmnopqrstuvwxyz',
  ])('detects the credential in %s', (text) => {
    expect(containsBrainCredential(text)).toBe(true);
  });

  it.each([
    'Die Pinnwand im Büro hängt links.',
    'Die Kennwortrichtlinie verlangt zwölf Zeichen.',
    'Das Passwort ist zu kurz.',
    'Pin 2 der Steckerleiste ist belegt.',
  ])('does not flag %s as a credential', (text) => {
    expect(containsBrainCredential(text)).toBe(false);
  });

  it.each([
    'Bericht für Patientin M., Diagnose Angststörung',
    'Sie macht Physiotherapie am Donnerstag.',
    'Ibuprofen 400 mg dreimal täglich',
    'Kontrolle der Medikation nach ICD-10',
    'Il paziente segue una terapia.',
    'La maladie est chronique.',
    'The prescription was renewed.',
  ])('detects health information in %s', (text) => {
    expect(containsBrainHealthData(text)).toBe(true);
  });

  it.each([
    'Offerte Küchenumbau Brunner bis Freitag',
    'Firewall-Regel für Kunde Keller freigeben',
    'Mahnung zweite Stufe an die Keller GmbH',
  ])('leaves ordinary business text alone: %s', (text) => {
    expect(containsBrainHealthData(text)).toBe(false);
    expect(brainAutomaticWithholding({ quote: text, kind: 'fact' })).toBeUndefined();
  });

  it('withholds third persons, health, identifiers and credentials from automatic learning', () => {
    expect(
      brainAutomaticWithholding({ quote: 'Herr Meier leitet den Einkauf.', kind: 'person' }),
    ).toBe('person');
    expect(
      brainAutomaticWithholding({
        quote: 'Sie bevorzugt kurze Berichte.',
        text: 'Kurze Berichte bevorzugt.',
        kind: 'preference',
        evidence: [{ quote: 'Die Patientin bevorzugt kurze Berichte.' }],
      }),
    ).toBe('health');
    expect(
      brainAutomaticWithholding({ quote: 'Mein Konto: CH93 0076 2011 6238 5295 7', kind: 'fact' }),
    ).toBe('identifier');
    expect(brainAutomaticWithholding({ quote: 'PIN 4711 für das Tor', kind: 'fact' })).toBe(
      'credential',
    );
  });
});
