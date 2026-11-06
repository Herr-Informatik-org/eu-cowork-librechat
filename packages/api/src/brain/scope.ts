import { brainAuthoredText } from './query';

/**
 * A Brain scope separates work for customers and projects. The user's own employer is
 * not such a context: own role, writing style and own rates apply to every task and
 * belong in the unscoped profile. Models nevertheless tend to scope them with the own
 * company name, which hides a style rule from the always-on profile.
 *
 * The rule is deliberately narrow, because a wrong match turns a customer memory into a
 * global one: only explicit self-statements in the message the person wrote themselves
 * count, and a scope is dropped only when it equals such a name exactly.
 */

/** Capitalised words; a full stop counts only inside a name (St.Gallen), never as sentence end. */
const word = "[\\p{Lu}\\p{N}](?:[\\p{L}\\p{N}&'’-]|\\.(?=[\\p{L}\\p{N}]))*";
const organization = `(${word}(?:[ \\t]+(?:&|${word}))*)`;
const article = '(?:der |die |dem |den |das |the )?';
/** Capitalised role nouns; roles that describe working for or with someone else do not count. */
const role =
  '(?:[ \\t]+als)?(?:[ \\t]+(?!(?:Kunde|Kundin|Mitglied|Gast|Patient|Patientin|Berater|Beraterin|Consultant|Lieferant|Lieferantin|Partner|Partnerin)(?![\\p{L}]))[\\p{Lu}][\\p{L}-]*){1,4}';

interface OwnOrganizationStatement {
  pattern: RegExp;
  /** The name must carry a legal form such as AG or GmbH to count. */
  requiresLegalForm: boolean;
}

const statement = (pattern: string, requiresLegalForm = false): OwnOrganizationStatement => ({
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, 'gu'),
  requiresLegalForm,
});

/**
 * The self-statements that name the own employer:
 * - «Ich arbeite bei X», also «als <Rolle>» or «seit <Zeit>» before «bei»
 * - «Ich bin bei X angestellt | tätig | beschäftigt»
 * - «Ich bin <Rolle> bei X» only with a legal form in X (Projektleiter bei der Muster AG)
 * - «Mein Arbeitgeber ist | heisst X», «Unsere Firma | Unser Unternehmen | Unser Betrieb heisst X»
 * - «Wir sind X» only with a legal form in X
 * - «I work at X», «I am employed at | by X», «Our company is called X»
 */
const ownOrganizationStatements = [
  statement(
    `[Ii]ch arbeite(?:${role}|[ \\t]+seit[ \\t]+[\\p{L}\\p{N}]+)?[ \\t]+bei[ \\t]+${article}${organization}`,
  ),
  statement(`[Ii]ch bin bei ${article}${organization}[ \\t]+(?:angestellt|tätig|beschäftigt)`),
  statement(`[Ii]ch bin${role}[ \\t]+bei[ \\t]+${article}${organization}`, true),
  statement(`[Mm]ein Arbeitgeber (?:ist|heisst) ${article}${organization}`),
  statement(
    `(?:[Uu]nsere Firma|[Uu]nser Unternehmen|[Uu]nser Betrieb) heisst ${article}${organization}`,
  ),
  statement(`[Ww]ir sind ${article}${organization}`, true),
  statement(`I (?:work at|am employed (?:at|by)) ${article}${organization}`),
  statement(`[Oo]ur company is called ${article}${organization}`),
];

const legalFormName =
  /(?<![\p{L}\p{N}])(?:AG|GmbH|SA|S[àa]rl|KG|KlG|Genossenschaft|Verein|Stiftung|Ltd|Inc|LLC|PLC|SE)(?![\p{L}\p{N}])/u;
const legalForm =
  /\b(?:ag|gmbh|sa|sarl|kg|klg|kgaa|ohg|gbr|ltd|llc|inc|plc|se|eg|genossenschaft|verein|stiftung)\b/gu;
/** Start of a forwarded or replied mail pasted below the user's own words. */
const pastedMail =
  /^(?:(?:von|from|an|to|gesendet|sent|betreff|subject|datum|date|cc)[ \t]*:|-{2,}[ \t]*(?:original|ursprüngliche|weitergeleitete|forwarded)|(?:am|on)[ \t][^\n]{3,160}(?:schrieb|wrote)[^\n]*:[ \t]*$)/imu;
/** A salutation after the first line starts a pasted letter or mail. */
const salutation =
  /^[ \t]*(?:sehr geehrte|guten (?:tag|morgen|abend)|grüezi|hallo|liebe|lieber|dear|hi)(?![\p{L}])/gimu;
const quoted = /«[^»]*»|„[^“”]*[“”]|“[^”]*”|"[^"\n]*"|‹[^›]*›/gu;

function core(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(legalForm, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The user's own words in a message: no marked sources, pasted mails, quoted lines or quotes. */
function ownWords(text: string): string {
  const authored = brainAuthoredText(text);
  const starts = [
    pastedMail.exec(authored)?.index,
    [...authored.matchAll(salutation)].find((match) => match.index > 0)?.index,
  ].filter((index): index is number => index !== undefined);
  return (starts.length ? authored.slice(0, Math.min(...starts)) : authored)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(quoted, ' ');
}

/** Own organisation names stated in the message the person wrote, in comparable form. */
export function ownBrainOrganizations(text: string): string[] {
  const own = ownWords(text);
  const names = new Set<string>();
  for (const { pattern, requiresLegalForm } of ownOrganizationStatements) {
    for (const match of own.matchAll(pattern)) {
      const raw = match[1] ?? '';
      if (requiresLegalForm && !legalFormName.test(raw)) continue;
      const name = core(raw);
      if (name.length >= 3) names.add(name);
    }
  }
  return [...names];
}

/** True only when the scope names exactly one of these organisations. */
export function isOwnBrainOrganizationScope(scope: string, organizations: string[]): boolean {
  const value = core(scope);
  return value.length >= 3 && organizations.includes(value);
}

/** Removes a scope that names the user's own organisation; all other fields stay as given. */
export function withoutOwnBrainScope<T extends { scope?: string }>(
  candidates: T[],
  organizations: string[],
): T[] {
  if (!organizations.length) return candidates;
  return candidates.map((candidate) =>
    candidate.scope && isOwnBrainOrganizationScope(candidate.scope, organizations)
      ? { ...candidate, scope: undefined }
      : candidate,
  );
}
