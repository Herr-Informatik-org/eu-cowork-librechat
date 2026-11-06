/** Matches a trailing line that only holds an unfinished block marker while streaming. */
const PENDING_MARKER_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)]?|#{1,6}|>|`{1,2}|~{1,2}|\|)?[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

/**
 * Hide markdown that would flash as literal characters before the next streamed chunk
 * completes it: a last line holding only a list, heading, quote, table or fence marker,
 * and trailing table rows whose delimiter row has not arrived yet. Only the tail of the
 * text is inspected, so the cost stays flat while a long answer streams. Applied to text
 * that is still streaming; the stored message is never changed.
 */
export function trimPendingMarkdown(text: string): string {
  if (!text) {
    return text;
  }
  let result = text;
  const lastBreak = result.lastIndexOf('\n');
  const lastLine = result.slice(lastBreak + 1);
  if (lastLine.length > 0 && PENDING_MARKER_LINE.test(lastLine)) {
    result = lastBreak >= 0 ? result.slice(0, lastBreak + 1) : '';
  }

  let end = result.length;
  while (end > 0 && /\s/.test(result[end - 1])) {
    end -= 1;
  }
  let tableStart = -1;
  let hasDelimiter = false;
  let lineEnd = end;
  while (lineEnd > 0) {
    const lineStart = result.lastIndexOf('\n', lineEnd - 1) + 1;
    const line = result.slice(lineStart, lineEnd);
    if (!TABLE_ROW.test(line)) {
      break;
    }
    hasDelimiter = hasDelimiter || TABLE_DELIMITER.test(line);
    tableStart = lineStart;
    lineEnd = lineStart - 1;
  }
  if (tableStart >= 0 && !hasDelimiter) {
    return result.slice(0, Math.max(0, tableStart - 1));
  }
  return result;
}
