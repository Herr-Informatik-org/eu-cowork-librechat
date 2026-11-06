/**
 * Turns raw tool arguments into what a person can check on a proposal card:
 * the target (model, record, path, recipient) and a short key/value list.
 * Pure; no JSON is ever shown as such.
 */

export interface ProposalField {
  key: string;
  label: string;
  value: string;
  /** Full value when `value` was shortened, for the tooltip. */
  full?: string;
  kind: 'text' | 'yes' | 'no' | 'empty';
}

export interface ProposalTarget {
  model?: string;
  ids?: string;
  path?: string;
  recipient?: string;
}

export interface ProposalView {
  target: ProposalTarget;
  fields: ProposalField[];
  /** Fields beyond {@link MAX_FIELDS}, announced as "+N weitere Felder". */
  moreCount: number;
  /** Model-authored intent label, when present. */
  intent?: string;
}

export const MAX_FIELDS = 12;
export const MAX_VALUE_CHARS = 160;
const MAX_IDS = 5;

const MODEL_KEYS = ['model', 'res_model', 'model_name', 'object', 'table', 'collection'];
const ID_KEYS = ['record_id', 'res_id', 'id', 'ids', 'record_ids'];
const PATH_KEYS = ['path', 'file_path', 'filepath', 'filename', 'file', 'url'];
const RECIPIENT_KEYS = ['to', 'recipient', 'recipients', 'email', 'emails', 'cc'];
const TARGET_KEYS = new Set([...MODEL_KEYS, ...ID_KEYS, ...PATH_KEYS, ...RECIPIENT_KEYS]);
/** Containers whose children are the actual values ("values" of Odoo `update_record`). */
const WRAPPER_KEYS = new Set([
  'values',
  'vals',
  'data',
  'fields',
  'payload',
  'params',
  'arguments',
  'args',
  'body',
  'record',
  'changes',
]);

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(args: unknown): Plain | string | undefined {
  if (isPlainObject(args)) {
    return args;
  }
  if (typeof args !== 'string' || args.trim() === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return isPlainObject(parsed) ? parsed : args;
  } catch {
    return args;
  }
}

function shorten(text: string): { value: string; full?: string } {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_VALUE_CHARS) {
    return { value: single };
  }
  return { value: `${single.slice(0, MAX_VALUE_CHARS - 1)}…`, full: single };
}

/** "partner_id" → "Partner", "emailFrom" → "Email from". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+ids?$/i, '')
    .trim()
    .toLowerCase();
  if (words === '') {
    return key;
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function toField(key: string, label: string, value: unknown): ProposalField {
  if (value === null || value === undefined || value === '') {
    return { key, label, value: '', kind: 'empty' };
  }
  if (typeof value === 'boolean') {
    return { key, label, value: '', kind: value ? 'yes' : 'no' };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return { key, label, kind: 'text', ...shorten(String(value)) };
  }
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return { key, label, kind: 'text', ...shorten(value.map(String).join(', ')) };
  }
  return { key, label, kind: 'text', ...shorten(compactJson(value)) };
}

function formatIds(value: unknown): string | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
    return String(value);
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const shown = value.slice(0, MAX_IDS).map(String).join(', ');
  return value.length > MAX_IDS ? `${shown} +${value.length - MAX_IDS}` : shown;
}

function firstString(source: Plain, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return shorten(value).value;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      return shorten(value.join(', ')).value;
    }
  }
  return undefined;
}

function readTarget(args: Plain): ProposalTarget {
  let ids: string | undefined;
  for (const key of ID_KEYS) {
    ids = formatIds(args[key]);
    if (ids != null) {
      break;
    }
  }
  return {
    model: firstString(args, MODEL_KEYS),
    ids,
    path: firstString(args, PATH_KEYS),
    recipient: firstString(args, RECIPIENT_KEYS),
  };
}

/** Builds the card content; `intent` and target keys never repeat as fields. */
export function buildProposalView(rawArgs: unknown): ProposalView {
  const parsed = parseArgs(rawArgs);
  if (parsed == null) {
    return { target: {}, fields: [], moreCount: 0 };
  }
  if (typeof parsed === 'string') {
    return { target: {}, fields: [toField('input', '', parsed)], moreCount: 0 };
  }
  const intent =
    typeof parsed.intent === 'string' && parsed.intent.trim() !== ''
      ? parsed.intent.trim()
      : undefined;
  const fields: ProposalField[] = [];
  let total = 0;
  const push = (key: string, value: unknown) => {
    total += 1;
    if (fields.length < MAX_FIELDS) {
      fields.push(toField(key, humanizeKey(key), value));
    }
  };
  /** Shell tools repeat the command split into `args`; showing both doubles the line. */
  const hasCommand = typeof parsed.command === 'string';
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'intent' || TARGET_KEYS.has(key) || (hasCommand && key === 'args')) {
      continue;
    }
    if (!isPlainObject(value)) {
      push(key, value);
      continue;
    }
    const prefix = WRAPPER_KEYS.has(key) ? '' : `${key}.`;
    for (const [childKey, childValue] of Object.entries(value)) {
      push(`${prefix}${childKey}`, childValue);
    }
  }
  return { target: readTarget(parsed), fields, moreCount: total - fields.length, intent };
}
