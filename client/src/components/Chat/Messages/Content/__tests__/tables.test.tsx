import React from 'react';
import remarkGfm from 'remark-gfm';
import ReactMarkdown from 'react-markdown';
import { render } from '@testing-library/react';
import { normalizeTables } from '../tables';

/** Tables GFM recognises when rendered, as their header cell counts. */
function tableWidths(markdown: string): number[] {
  const { container, unmount } = render(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>,
  );
  const widths = Array.from(container.querySelectorAll('table')).map(
    (table) => table.querySelectorAll('thead th').length,
  );
  unmount();
  return widths;
}

const RESTARTED = [
  '### Folie 4 – Die Zahlen (aus der Excel-Mastertabelle)',
  '| Grösse | Wert | Excel-Zelle (Mastertabelle) |',
  '|---|---|Oops, das geriet beim Formulieren entgleist. Neu:| Grösse | Wert | Quelle |',
  '|---|---|---|',
  '| Masse M | ≈ 4,3 Mio M☉ (8,55 × 10³⁶ kg) | Mastertabelle Zeile 10 |',
  '| Schwarzschild-Radius r_s | ≈ 12,7 Mio km | Spalte D |',
  '| Horizontdurchmesser | ≈ 25,4 Mio km | = 2·r_s |',
  '',
].join('\n');

describe('normalizeTables', () => {
  describe('restarted table', () => {
    it('replaces the aborted header and the self-correction with the restarted header', () => {
      expect(tableWidths(RESTARTED)).toEqual([]);

      const result = normalizeTables(RESTARTED);

      expect(result).toBe(
        [
          '### Folie 4 – Die Zahlen (aus der Excel-Mastertabelle)',
          '| Grösse | Wert | Quelle |',
          '|---|---|---|',
          '| Masse M | ≈ 4,3 Mio M☉ (8,55 × 10³⁶ kg) | Mastertabelle Zeile 10 |',
          '| Schwarzschild-Radius r_s | ≈ 12,7 Mio km | Spalte D |',
          '| Horizontdurchmesser | ≈ 25,4 Mio km | = 2·r_s |',
          '',
        ].join('\n'),
      );
      expect(result).not.toContain('Oops');
      expect(tableWidths(result)).toEqual([3]);
    });

    it('waits until the delimiter row after the restart is complete', () => {
      const lines = RESTARTED.split('\n');
      const streamingDelimiter = lines.slice(0, 4).join('\n');
      expect(normalizeTables(streamingDelimiter)).toBe(streamingDelimiter);

      const partialDelimiter = `${lines.slice(0, 3).join('\n')}\n|---|---|`;
      expect(normalizeTables(partialDelimiter)).toBe(partialDelimiter);

      const complete = `${lines.slice(0, 4).join('\n')}\n| Mas`;
      expect(normalizeTables(complete)).toContain(
        '| Grösse | Wert | Quelle |\n|---|---|---|\n| Mas',
      );
    });

    it('stays stable once applied while more rows stream in', () => {
      const lines = RESTARTED.split('\n');
      const results = [5, 6, 7].map((end) =>
        normalizeTables(`${lines.slice(0, end).join('\n')}\n`),
      );
      for (const result of results) {
        expect(result.split('\n').slice(0, 3)).toEqual([
          '### Folie 4 – Die Zahlen (aus der Excel-Mastertabelle)',
          '| Grösse | Wert | Quelle |',
          '|---|---|---|',
        ]);
      }
    });

    it('leaves the lines alone when the restarted header does not fit the delimiter row', () => {
      const markdown = [
        '| a | b | c |',
        '|---|---|oops| x | y |',
        '|---|---|---|',
        '| 1 | 2 | 3 |',
      ].join('\n');
      expect(normalizeTables(markdown)).toBe(markdown);
    });

    it('does not touch the lines when inline code is involved', () => {
      const markdown = [
        '| a | b | c |',
        '|---|---|see `x`:| a | b | c |',
        '|---|---|---|',
        '| 1 | 2 | 3 |',
      ].join('\n');
      expect(normalizeTables(markdown)).toBe(markdown);
    });
  });

  describe('delimiter cell count', () => {
    it('pads a short delimiter row to the header width', () => {
      const markdown = '| a | b | c |\n|---|:---:|\n| 1 | 2 | 3 |\n';
      expect(tableWidths(markdown)).toEqual([]);

      const result = normalizeTables(markdown);

      expect(result).toBe('| a | b | c |\n|---|:---:|---|\n| 1 | 2 | 3 |\n');
      expect(tableWidths(result)).toEqual([3]);
    });

    it('trims a long delimiter row and keeps body rows unchanged', () => {
      const markdown = '| a | b |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 |\n';
      const result = normalizeTables(markdown);
      expect(result).toBe('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |\n');
      expect(tableWidths(result)).toEqual([2]);
    });

    it('does not fix a delimiter row that is still the streaming last line', () => {
      const markdown = '| a | b | c |\n|---|---|';
      expect(normalizeTables(markdown)).toBe(markdown);
    });

    it('leaves a header with inline code alone', () => {
      const markdown = '| `a|b` | c |\n|---|---|\n| 1 | 2 |\n';
      expect(normalizeTables(markdown)).toBe(markdown);
    });

    it('never treats table body rows as a new header', () => {
      const markdown = '| a | b |\n|---|---|\n| 1 | 2 |\n|---|---|---|\n| 3 | 4 |\n';
      expect(normalizeTables(markdown)).toBe(markdown);
    });
  });

  describe('content that is not a broken table', () => {
    it('returns valid tables unchanged, by reference', () => {
      const markdown = 'Intro\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\nOutro\n';
      expect(normalizeTables(markdown)).toBe(markdown);
      expect(tableWidths(markdown)).toEqual([2]);
    });

    it('ignores tables inside fenced code blocks', () => {
      const fenced = '```md\n| a | b | c |\n|---|---|\n```\n';
      const tilde = '~~~\n| a | b |\n|---|---|oops| a | b |\n|---|---|\n~~~\n';
      const unclosed = 'Text\n```\n| a | b | c |\n|---|---|\n| 1 | 2 | 3 |\n';
      expect(normalizeTables(fenced)).toBe(fenced);
      expect(normalizeTables(tilde)).toBe(tilde);
      expect(normalizeTables(unclosed)).toBe(unclosed);
    });

    it('resumes after a closed fence', () => {
      const markdown = '```\ncode\n```\n| a | b | c |\n|---|---|\n| 1 | 2 | 3 |\n';
      expect(normalizeTables(markdown)).toBe(
        '```\ncode\n```\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n',
      );
    });

    it('ignores single pipes in prose and lines that only look like rules', () => {
      const markdown = [
        'Use a | b to pipe output - not a table.',
        '|x| is the absolute value - see below.',
        '',
        'Title',
        '---',
        '- item | with pipe',
      ].join('\n');
      expect(normalizeTables(markdown)).toBe(markdown);
    });

    it('ignores indented code that looks like a table', () => {
      const markdown = '    | a | b | c |\n    |---|---|\n';
      expect(normalizeTables(markdown)).toBe(markdown);
    });

    it('returns text without pipes as is', () => {
      expect(normalizeTables('')).toBe('');
      expect(normalizeTables('Just - some text')).toBe('Just - some text');
    });
  });
});
