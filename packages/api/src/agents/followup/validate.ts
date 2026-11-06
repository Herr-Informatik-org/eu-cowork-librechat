import type { TNextStep } from 'librechat-data-provider';

export const MAX_NEXT_STEPS = 3;
export const NEXT_STEP_MIN_CHARS = 8;
export const NEXT_STEP_MAX_CHARS = 120;

/** Openings that ask the person something instead of phrasing their next instruction. */
const QUESTION_OPENINGS = [
  'möchten sie',
  'möchtest du',
  'wollen sie',
  'willst du',
  'wünschen sie',
  'soll ich',
  'sollen wir',
  'darf ich',
  'kann ich',
  'können sie mir',
  'brauchen sie',
  'haben sie',
  'benötigen sie',
  'gibt es noch',
  'do you want',
  'would you like',
  'shall i',
  'should i',
  'can i',
  'may i',
  'voulez-vous',
  'vuole',
];

/** Lines without a next step (lower case, no surrounding punctuation). */
const PLATITUDES = new Set([
  'danke',
  'vielen dank',
  'das wars',
  'das ist alles',
  'weitere fragen',
  'noch fragen',
  'noch etwas',
  'mehr erfahren',
  'mehr details',
  'mehr informationen',
  'weitere informationen',
  'details anzeigen',
  'nächste schritte',
  'hilfe',
  'thank you',
  'thanks',
  'more details',
  'learn more',
  'next steps',
  'anything else',
]);

const MARKUP = ['](', 'http://', 'https://', 'www.', '<', '>', '`', '**', '/api/', '\\'];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LONG_HEX = /\b[0-9a-f]{16,}\b/i;
const ID_REFERENCE = /(^|[\s(])(?:[\p{L}-]*-)?id[:\s#]*\d/iu;
const HASH_NUMBER = /(^|\s)#\d/;
const PATH = /(^|\s)(?:~?\/[\w.-]+\/[\w./-]*|[a-z]:\\)/i;
const SNAKE_CASE = /[\p{L}\d]_[\p{L}\d]/u;
const SHOUTED_CODE = /\b[A-Z]{5,}\b/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const BULLET = /^(?:[-*•–]\s*|\d{1,2}[.)]\s+)/;
const LEADING_QUOTES = /^[«»"„“”'‹›]+/;
const TRAILING_QUOTES = /[«»"„“”'‹›]+$/;
const ELLIPSIS = /\s*(?:…|\.{3})$/;

/** Text for comparisons: lower case, single spaces, no punctuation at the edges. */
export const comparable = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '')
    .replace(/['’]/g, '');

/** Reason a candidate line is dropped, or null when it is usable. Exported for tests. */
export function rejectReason(text: string, request: string): string | null {
  const length = [...text].length;
  if (length < NEXT_STEP_MIN_CHARS || length > NEXT_STEP_MAX_CHARS) {
    return 'length';
  }
  if (text.split(' ').length < 2) {
    return 'length';
  }
  if (CONTROL.test(text)) {
    return 'control';
  }
  const lower = text.toLowerCase();
  if (MARKUP.some((marker) => lower.includes(marker)) || PATH.test(text)) {
    return 'markup';
  }
  if (UUID.test(text) || LONG_HEX.test(text) || ID_REFERENCE.test(text) || HASH_NUMBER.test(text)) {
    return 'id';
  }
  if (SNAKE_CASE.test(text) || SHOUTED_CODE.test(text)) {
    return 'code';
  }
  if (QUESTION_OPENINGS.some((opening) => lower.startsWith(opening))) {
    return 'question';
  }
  const normalized = comparable(text);
  if (PLATITUDES.has(normalized)) {
    return 'platitude';
  }
  if (request.trim() !== '' && normalized === comparable(request)) {
    return 'repeat';
  }
  return null;
}

/** Strips quotes that wrap the whole line, never the closing quote of a quotation inside it. */
function unwrapQuotes(line: string): string {
  if (!LEADING_QUOTES.test(line)) {
    return line;
  }
  return line.replace(LEADING_QUOTES, '').replace(TRAILING_QUOTES, '');
}

function cleanLine(raw: string): { text: string; needsInput: boolean } | null {
  const line = unwrapQuotes(raw.replace(/\s+/g, ' ').trim().replace(BULLET, '')).trim();
  if (line === '') {
    return null;
  }
  const needsInput = ELLIPSIS.test(line);
  const text = needsInput ? line.replace(ELLIPSIS, '').trim() : line;
  return { text, needsInput };
}

/**
 * Turns a raw `<naechste_schritte>` block into at most three usable next
 * steps: bullets and quotes are stripped, a trailing «…» marks a step the
 * person completes, and links, paths, ids, codes, questions to the person,
 * platitudes, duplicates and a repeat of the request are dropped.
 */
export function validateNextSteps(block: string, request = ''): TNextStep[] {
  const steps: TNextStep[] = [];
  const seen = new Set<string>();
  for (const raw of block.split('\n')) {
    const line = cleanLine(raw);
    if (!line || rejectReason(line.text, request) != null) {
      continue;
    }
    const key = comparable(line.text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    steps.push(line.needsInput ? { text: line.text, needsInput: true } : { text: line.text });
    if (steps.length === MAX_NEXT_STEPS) {
      break;
    }
  }
  return steps;
}
