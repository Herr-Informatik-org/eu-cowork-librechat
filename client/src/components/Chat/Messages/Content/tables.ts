/**
 * Repairs two pipe-table mistakes models make while writing, so GFM still
 * recognises the table instead of printing raw pipes:
 *
 * 1. A restarted table: the model breaks off inside the delimiter row, writes
 *    a correction and starts the header again on the same line. The aborted
 *    header and the broken line are replaced by the restarted header.
 * 2. A delimiter row whose cell count differs from the header's: GFM rejects
 *    the whole table, so the delimiter row is padded or trimmed to fit.
 *
 * Only pipe-table lines are rewritten. Fenced code, rows containing inline
 * code and table bodies stay untouched. A rule only applies once the delimiter
 * row it depends on ends with a line break, so a streaming last line never
 * flips the structure back and forth.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const ROW_START = /^ {0,3}\|/;
const INDENT = /^ {0,3}/;
const SHALLOW = /^ {0,3}\S/;
const DELIMITER_CELL = /^:?-+:?$/;
const DELIMITER_PREFIX = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+/;
const WORDS = /[^\s|:-]/;

type Fence = { char: string; size: number };

/** Cells of a pipe row: outer pipes are optional, escaped pipes stay in their cell. */
function splitCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let current = '';
  let closed = false;
  for (let i = text.startsWith('|') ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      current += char + text[i + 1];
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      closed = i === text.length - 1;
      continue;
    }
    current += char;
  }
  if (!closed) {
    cells.push(current);
  }
  return cells;
}

/** Positions of pipes that separate cells, skipping escaped ones. */
function pipePositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i += 1;
    } else if (text[i] === '|') {
      positions.push(i);
    }
  }
  return positions;
}

function isDelimiterRow(line: string | undefined): boolean {
  if (line == null || !line.includes('|') || !SHALLOW.test(line)) {
    return false;
  }
  return splitCells(line).every((cell) => DELIMITER_CELL.test(cell.trim()));
}

const isRow = (line: string | undefined): boolean => line != null && ROW_START.test(line);

const indentOf = (line: string): string => INDENT.exec(line)?.[0] ?? '';

/** A header candidate: a pipe row that is not a delimiter and does not continue another pipe row. */
const canStartTable = (line: string, previous: string | undefined): boolean =>
  isRow(line) && !isDelimiterRow(line) && !isRow(previous);

/**
 * The restarted header hidden in the broken line, when `lines[i]` is an
 * aborted header, `lines[i + 1]` starts as a delimiter row but continues with
 * prose and a new header row, and `lines[i + 2]` is a complete delimiter row
 * with exactly as many cells as that new header.
 */
function restartedHeader(lines: string[], i: number): string | null {
  const header = lines[i];
  const broken = lines[i + 1];
  const delimiter = lines[i + 2];
  if (i + 2 >= lines.length - 1 || broken == null || !isDelimiterRow(delimiter)) {
    return null;
  }
  if (header.includes('`') || broken.includes('`') || isDelimiterRow(broken)) {
    return null;
  }
  const prefix = DELIMITER_PREFIX.exec(broken);
  if (!prefix) {
    return null;
  }
  const rest = broken.slice(prefix[0].length).trimEnd();
  if (!rest.endsWith('|')) {
    return null;
  }
  const target = splitCells(delimiter).length;
  for (const position of pipePositions(rest)) {
    const row = rest.slice(position);
    if (splitCells(row).length !== target) {
      continue;
    }
    if (!WORDS.test(rest.slice(0, position)) || isDelimiterRow(row)) {
      return null;
    }
    return indentOf(header) + row;
  }
  return null;
}

/** The delimiter row cut or padded to `count` cells, keeping existing alignment marks. */
function fitDelimiter(delimiter: string, count: number): string {
  const cells = splitCells(delimiter)
    .map((cell) => cell.trim())
    .slice(0, count);
  while (cells.length < count) {
    cells.push('---');
  }
  return `${indentOf(delimiter)}|${cells.join('|')}|`;
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match != null && match[1][0] === fence.char && match[1].length >= fence.size;
}

export function normalizeTables(markdown: string): string {
  if (!markdown.includes('|') || !markdown.includes('-')) {
    return markdown;
  }
  const lines = markdown.split('\n');
  const out: string[] = [];
  const last = lines.length - 1;
  let fence: Fence | null = null;
  let inTable = false;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening) {
      fence = { char: opening[1][0], size: opening[1].length };
      inTable = false;
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      inTable = false;
      out.push(line);
      continue;
    }
    if (inTable || !canStartTable(line, lines[i - 1])) {
      out.push(line);
      continue;
    }

    const restarted = restartedHeader(lines, i);
    if (restarted != null) {
      out.push(restarted, lines[i + 2]);
      i += 2;
      inTable = true;
      changed = true;
      continue;
    }

    const delimiter = lines[i + 1];
    if (!isDelimiterRow(delimiter)) {
      out.push(line);
      continue;
    }
    const count = splitCells(line).length;
    const matches = splitCells(delimiter).length === count;
    if (!matches && (i + 1 >= last || line.includes('`'))) {
      out.push(line);
      continue;
    }
    out.push(line, matches ? delimiter : fitDelimiter(delimiter, count));
    changed = changed || !matches;
    inTable = true;
    i += 1;
  }

  return changed ? out.join('\n') : markdown;
}
