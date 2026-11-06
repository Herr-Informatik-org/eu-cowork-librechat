import { trimPendingMarkdown } from '../streaming';

describe('trimPendingMarkdown', () => {
  it('keeps complete text unchanged', () => {
    expect(trimPendingMarkdown('Hallo Welt')).toBe('Hallo Welt');
    expect(trimPendingMarkdown('- erster Punkt\n- zweiter Punkt')).toBe(
      '- erster Punkt\n- zweiter Punkt',
    );
  });

  it.each(['-', '1.', '##', '>', '``', '|', '  * '])(
    'hides a trailing line that only holds the marker %p',
    (marker) => {
      expect(trimPendingMarkdown(`Einleitung\n${marker}`)).toBe('Einleitung\n');
    },
  );

  it('hides table rows until the delimiter row arrives', () => {
    expect(trimPendingMarkdown('Übersicht:\n\n| Name | Betrag |')).toBe('Übersicht:\n');
    const table = 'Übersicht:\n\n| Name | Betrag |\n| --- | ---: |\n| Miete | 1200 |';
    expect(trimPendingMarkdown(table)).toBe(table);
  });

  it('keeps a code fence that already has content', () => {
    const code = '```python\nprint(1)';
    expect(trimPendingMarkdown(code)).toBe(code);
  });

  it('returns empty text for a lone marker', () => {
    expect(trimPendingMarkdown('-')).toBe('');
    expect(trimPendingMarkdown('')).toBe('');
  });
});
