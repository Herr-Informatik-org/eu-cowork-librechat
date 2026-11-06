import { BlockSplitter, partialMarkerAtEnd, NEXT_STEPS_START } from './splitter';

/** Streams the chunks through one splitter: visible text (incl. finish) and the block. */
function split(chunks: string[]): { visible: string; block: string | null; saw: boolean } {
  const splitter = new BlockSplitter();
  let visible = '';
  for (const chunk of chunks) {
    visible += splitter.push(chunk);
  }
  visible += splitter.finish();
  return { visible, block: splitter.block(), saw: splitter.sawBlock() };
}

/** Every way of cutting `text` into two chunks, plus one-character chunks. */
function cuttings(text: string): string[][] {
  const out: string[][] = [];
  for (let i = 0; i <= text.length; i++) {
    out.push([text.slice(0, i), text.slice(i)]);
  }
  out.push(text.split(''));
  out.push(Array.from(text));
  return out;
}

const ANSWER = 'Zwei Rechnungen sind überfällig.';
const BLOCK = '\nFasse die Mahnliste zusammen\nEntwirf eine Mahnung an Frau Müller: …\n';
const FULL = `${ANSWER}\n\n<naechste_schritte>${BLOCK}</naechste_schritte>`;

describe('BlockSplitter', () => {
  it('never lets any part of the block reach the reader, however the stream is cut', () => {
    for (const chunks of cuttings(FULL)) {
      const { visible, block } = split(chunks);
      expect(visible).toBe(ANSWER);
      expect(block).toBe(BLOCK);
    }
  });

  it('never emits a prefix of the marker during streaming', () => {
    const splitter = new BlockSplitter();
    let emitted = '';
    for (const char of FULL) {
      emitted += splitter.push(char);
      expect(emitted).not.toContain('<n');
      expect(emitted).not.toContain('Fasse');
    }
  });

  it('keeps multi-byte characters intact around the marker', () => {
    const text = `Grüsse aus Zürich 🇨🇭 – Ölpreis «hoch»\n<naechste_schritte>\nÜbersetze den Brief ins Französische\n</naechste_schritte>`;
    for (const chunks of cuttings(text)) {
      const { visible, block } = split(chunks);
      expect(visible).toBe('Grüsse aus Zürich 🇨🇭 – Ölpreis «hoch»');
      expect(block).toBe('\nÜbersetze den Brief ins Französische\n');
    }
  });

  it('passes text without a block through unchanged and releases look-alikes', () => {
    expect(split(['Beträge <5', '00 sind klein.'])).toEqual({
      visible: 'Beträge <500 sind klein.',
      block: null,
      saw: false,
    });
    expect(split(['Text <naechste', '_x> bleibt']).visible).toBe('Text <naechste_x> bleibt');
    expect(split(['Endet mit <nae']).visible).toBe('Endet mit <nae');
  });

  it('holds whitespace between chunks but drops it only at the end', () => {
    const splitter = new BlockSplitter();
    expect(splitter.push('Eins ')).toBe('Eins');
    expect(splitter.push('zwei\n\n')).toBe(' zwei');
    expect(splitter.push('drei')).toBe('\n\ndrei');
    expect(splitter.finish()).toBe('');
  });

  it('hides an unterminated block at the end and reports it as incomplete', () => {
    const result = split(['Antwort.\n<naechste_schritte>\nFasse das Protokoll zus']);
    expect(result.visible).toBe('Antwort.');
    expect(result.block).toBeNull();
    expect(result.saw).toBe(true);
  });

  it('returns no block when the answer has none', () => {
    expect(split(['Nur eine Antwort.'])).toEqual({
      visible: 'Nur eine Antwort.',
      block: null,
      saw: false,
    });
  });

  it('keeps text after a block and lets the last of several blocks win', () => {
    expect(split(['A <naechste_schritte>x</naechste_schritte> B'])).toEqual({
      visible: 'A B',
      block: 'x',
      saw: true,
    });
    const many = split([
      'Eins\n<naechste_schritte>alt</naechste_schritte>\nZwei',
      '\n<naechste_schritte>neu</naechste_schritte>',
    ]);
    expect(many.visible).toBe('Eins\nZwei');
    expect(many.block).toBe('neu');
  });

  it('does not cut a marker inside a fenced code block', () => {
    const code =
      'So sieht der Block aus:\n```\n<naechste_schritte>\nBeispiel\n</naechste_schritte>\n```';
    for (const chunks of cuttings(code)) {
      const { visible, block } = split(chunks);
      expect(visible).toBe(code);
      expect(block).toBeNull();
    }
  });

  it('cuts a real block that follows a closed code block', () => {
    const text =
      '```js\nconst a = 1;\n```\nFertig.\n<naechste_schritte>\nErkläre den Code Zeile für Zeile\n</naechste_schritte>';
    for (const chunks of cuttings(text)) {
      const { visible, block } = split(chunks);
      expect(visible).toBe('```js\nconst a = 1;\n```\nFertig.');
      expect(block).toBe('\nErkläre den Code Zeile für Zeile\n');
    }
  });

  it('leaves inline code mentions of the marker alone', () => {
    const text = 'Der Block `<naechste_schritte>` wird ausgeblendet.';
    expect(split([text]).visible).toBe(text);
    expect(split([text]).block).toBeNull();
  });

  it('release() hands back a held marker-like tail at a step boundary', () => {
    const splitter = new BlockSplitter();
    expect(splitter.push('Ich prüfe das <')).toBe('Ich prüfe das');
    expect(splitter.release()).toBe(' <');
    expect(splitter.push('naechste')).toBe('naechste');
  });
});

describe('partialMarkerAtEnd', () => {
  it('finds only real prefixes of the marker', () => {
    expect(partialMarkerAtEnd('abc <naech', NEXT_STEPS_START)).toBe(6);
    expect(partialMarkerAtEnd('abc <', NEXT_STEPS_START)).toBe(1);
    expect(partialMarkerAtEnd('abc <x', NEXT_STEPS_START)).toBe(0);
    expect(partialMarkerAtEnd(NEXT_STEPS_START, NEXT_STEPS_START)).toBe(0);
  });
});
