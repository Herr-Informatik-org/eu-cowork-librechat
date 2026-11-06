import { validateNextSteps, rejectReason } from './validate';

describe('validateNextSteps', () => {
  it('strips bullets, numbering, quotes and spacing; keeps at most three', () => {
    const block = [
      '',
      '- Fasse   das Protokoll zusammen',
      '2. Entwirf eine Mahnung an Frau Müller: …',
      '* Zeige die offenen Posten nach Kunde',
      '«Erstelle eine Excel-Liste der Rechnungen»',
      '',
    ].join('\n');
    expect(validateNextSteps(block, 'Was steht heute an?')).toEqual([
      { text: 'Fasse das Protokoll zusammen' },
      { text: 'Entwirf eine Mahnung an Frau Müller:', needsInput: true },
      { text: 'Zeige die offenen Posten nach Kunde' },
    ]);
  });

  it('keeps a quotation inside the line intact', () => {
    expect(
      validateNextSteps('Formuliere die Mail förmlicher mit «Sehr geehrte Frau Brunner»'),
    ).toEqual([{ text: 'Formuliere die Mail förmlicher mit «Sehr geehrte Frau Brunner»' }]);
  });

  it('accepts three dots as an open ending', () => {
    expect(validateNextSteps('Neue Adresse von Anna Muster: ...')).toEqual([
      { text: 'Neue Adresse von Anna Muster:', needsInput: true },
    ]);
  });

  it('drops links, paths, ids, codes, questions, platitudes, repeats and duplicates', () => {
    const block = [
      'Danke!',
      'Möchten Sie das Protokoll zusammenfassen?',
      'Soll ich eine Aufgabe erfassen?',
      'Would you like a summary?',
      'Öffne [Rechnung 12](/rechnungen/12)',
      'Siehe https://example.ch für Details',
      'Fasse Rechnung ID 12 zusammen',
      'Öffne Kunden-ID 3 im ERP',
      'Zeige Auftrag #12 im Detail',
      'Fasse 01a16a6d-3773-7773-9428-9c2154dd7273 zusammen',
      'Öffne 64f1a2b3c4d5e6f7a8b9c0d1 im System',
      'Zeige Aufträge mit Status SISTIERT',
      'Rufe search_records erneut auf',
      'Lies /mnt/data/_work/log.txt ein',
      'Formatiere **fett** die Überschrift',
      'Weitere Fragen?',
      'Was steht heute an?',
      'Kurz',
      'Einwort-Vorschlag',
      'Fasse das Protokoll zusammen',
      'fasse das protokoll zusammen.',
    ].join('\n');
    expect(validateNextSteps(block, 'Was steht heute an?')).toEqual([
      { text: 'Fasse das Protokoll zusammen' },
    ]);
  });

  it('rejects overly long lines and control characters', () => {
    expect(rejectReason('Fasse '.repeat(30).trim(), '')).toBe('length');
    expect(rejectReason('Fasse das\u0007 zusammen', '')).toBe('control');
  });

  it('accepts ordinary instructions, also as questions from the person', () => {
    expect(rejectReason('Welche Rechnungen sind überfällig?', '')).toBeNull();
    expect(rejectReason('Übersetze die Antwort ins Englische', '')).toBeNull();
    expect(rejectReason('Vergleiche die Offerte mit 2024', '')).toBeNull();
  });

  it('returns an empty list for an empty block', () => {
    expect(validateNextSteps('\n\n')).toEqual([]);
  });
});
