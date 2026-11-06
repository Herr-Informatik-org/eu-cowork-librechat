import type { BrainKind } from 'librechat-data-provider';

/** Reason a candidate is never stored by automatic learning. */
export type BrainWithholding = 'credential' | 'identifier' | 'health' | 'person';

interface BrainSensitiveCandidate {
  quote?: string;
  text?: string;
  title?: string;
  scope?: string;
  kind: BrainKind;
  evidence?: { quote: string }[];
}

const secretPattern =
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._~+/-]{16,})|\b(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[a-zA-Z0-9_+/-]{12,}/i;
const passwordPattern =
  /(?<![\p{L}\p{N}])(?:password|passwort|kennwort|passcode|pw|pwd|mot de passe|parola d'ordine|zugangscode|codewort)(?![\p{L}\p{N}])\s*(?:[:=]|(?:is|ist|lautet|est|è)(?![\p{L}\p{N}]))\s*\S{3,}/iu;
const pinPattern =
  /(?<![\p{L}\p{N}])(?:pin|puk)(?:[- ]?(?:code|nummer|number))?(?![\p{L}\p{N}])\s*(?:[:=]|(?:is|ist|lautet|est|è)(?![\p{L}\p{N}]))?\s*\d{4,8}(?!\d)/iu;
const ibanPattern = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![a-z0-9])/g;
const ahvPattern = /(?<!\d)756[. ]?\d{4}[. ]?\d{4}[. ]?\d{2}(?!\d)/g;
const cardPattern = /(?<![\d-])[2-6]\d{3}(?:[ -]?\d){9,15}(?![\d-])/g;

/** Fixed IBAN lengths of the SEPA area including Switzerland and Liechtenstein. */
const ibanLengths: Record<string, number> = {
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  VA: 22,
};

/** Card networks by issuer prefix and permitted length (Visa, Mastercard, Amex, Diners, JCB, Discover, UnionPay, Maestro). */
const cardNetworks: { prefix: RegExp; lengths: number[] }[] = [
  { prefix: /^4/, lengths: [13, 16, 19] },
  { prefix: /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/, lengths: [16] },
  { prefix: /^3[47]/, lengths: [15] },
  { prefix: /^3(?:0[0-5]|[68])/, lengths: [14] },
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
  { prefix: /^6(?:011|5|4[4-9]|2)/, lengths: [16, 17, 18, 19] },
  { prefix: /^(?:5[06-9]|6)/, lengths: [13, 14, 15, 16, 17, 18, 19] },
];

/** Clinical vocabulary in German, French, Italian and English, matched at word starts. */
const healthStems = [
  'diagnos',
  'befund',
  'therapi',
  'therapeut',
  'psychiatr',
  'medikation',
  'arznei',
  'dosierung',
  'krankheit',
  'erkrank',
  'krankschreib',
  'arbeitsunfähig',
  'arztzeugnis',
  'arztbericht',
  'patient',
  'angststörung',
  'depression',
  'depressiv',
  'burnout',
  'burn-out',
  'diabetes',
  'tumor',
  'krebserkrank',
  'chemotherap',
  'schwanger',
  'thérapi',
  'médicament',
  'maladie',
  'dépression',
  'anxiété',
  'posologie',
  'grossesse',
  'enceinte',
  'traitement médical',
  'terapi',
  'terapeut',
  'farmac',
  'medicinal',
  'malattia',
  'pazient',
  'depressione',
  'ansia',
  'gravidanza',
  'posologia',
  'medication',
  'prescription',
  'dosage',
  'illness',
  'disease',
  'anxiety',
  'pregnan',
];
/** German compounds carry the clinical part at the end, such as Physiotherapie or Schmerzmedikament. */
const healthParts = ['therapie', 'therapeut', 'medikament', 'erkrankung'];
const healthPattern = new RegExp(
  [
    `(?<![\\p{L}\\p{N}])(?:${healthStems.join('|')})`,
    `(?:${healthParts.join('|')})`,
    '(?<![\\p{L}\\p{N}])icd-?1[01](?!\\p{N})',
    '\\d\\s?mg(?!\\p{L})',
  ].join('|'),
  'iu',
);

function mod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/** ISO 13616 check: SEPA country length and mod 97 of the rearranged account number. */
export function isValidIban(value: string): boolean {
  const compact = value.replace(/ /g, '').toUpperCase();
  const length = ibanLengths[compact.slice(0, 2)];
  if (length === undefined || compact.length < length) return false;
  const iban = compact.slice(0, length);
  return /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) && mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

/** Swiss AHV/AVS number: 756 prefix, 13 digits, EAN-13 check digit. */
export function isValidAhv(value: string): boolean {
  const digits = value.replace(/[. ]/g, '');
  if (!/^756\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 12; index++) {
    sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

/** Payment card number of a known network with a valid Luhn checksum. */
export function isValidCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  if (
    !cardNetworks.some(
      (network) => network.prefix.test(digits) && network.lengths.includes(digits.length),
    )
  )
    return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const matches = (text: string, pattern: RegExp, valid: (value: string) => boolean): boolean =>
  [...text.matchAll(pattern)].some((match) => valid(match[0]));

/** Credentials and payment card numbers are never stored, not even on explicit request. */
export function containsBrainCredential(text: string): boolean {
  return (
    secretPattern.test(text) ||
    passwordPattern.test(text) ||
    pinPattern.test(text) ||
    matches(text, cardPattern, isValidCardNumber)
  );
}

/** Account and person identifiers (IBAN, AHV) are stored only on explicit request. */
export function containsBrainIdentifier(text: string): boolean {
  return matches(text, ibanPattern, isValidIban) || matches(text, ahvPattern, isValidAhv);
}

/** Diagnosis, therapy and medication vocabulary; deliberately broad for automatic learning. */
export function containsBrainHealthData(text: string): boolean {
  return healthPattern.test(text);
}

/** Automatic learning skips sensitive candidates; explicit requests decide separately. */
export function brainAutomaticWithholding(
  candidate: BrainSensitiveCandidate,
): BrainWithholding | undefined {
  if (candidate.kind === 'person') return 'person';
  const text = [
    candidate.quote,
    candidate.text,
    candidate.title,
    candidate.scope,
    ...(candidate.evidence?.map((entry) => entry.quote) ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  if (containsBrainCredential(text)) return 'credential';
  if (containsBrainIdentifier(text)) return 'identifier';
  if (containsBrainHealthData(text)) return 'health';
  return undefined;
}

export function brainLearningTimeoutMs(): number {
  const configured = Number(process.env.BRAIN_LEARNING_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 30000
    ? Math.min(Math.round(configured), 300000)
    : 120000;
}
