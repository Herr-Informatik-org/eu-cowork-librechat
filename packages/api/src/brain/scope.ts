/**
 * A Brain scope separates work for customers and projects. The user's own employer is
 * not such a context: own role, writing style and own rates apply to every task and
 * belong in the unscoped profile. Models nevertheless tend to scope them with the own
 * company name, which hides a style rule from the always-on profile.
 */

/** Capitalised words; a full stop counts only inside a name (St.Gallen), never as sentence end. */
const word = "[\\p{Lu}\\p{N}](?:[\\p{L}\\p{N}&'’-]|\\.(?=[\\p{L}\\p{N}]))*";
const organization = `(${word}(?:[ \\t]+(?:&|${word}))*)`;
const article = '(?:der |die |dem |den |das |einer |einem |the )?';

/**
 * Statements that name the user's own employer, never a customer they work for or visit.
 * German roles are capitalised nouns, so «Ich bin Projektleiter bei X» qualifies while a
 * visit such as «Ich bin morgen bei X» does not.
 */
const role =
  '(?:[ \\t]+als)?(?:[ \\t]+(?!(?:Kunde|Kundin|Mitglied|Gast|Patient|Patientin)(?![\\p{L}]))[\\p{Lu}][\\p{L}-]*){1,4}';
const ownOrganizationPatterns = [
  `[Ii]ch bin${role}[ \\t]+(?:bei|von)[ \\t]+${article}${organization}`,
  `[Ii]ch arbeite(?:${role}|[ \\t]+seit[ \\t]+[\\p{L}\\p{N}]+)?[ \\t]+bei[ \\t]+${article}${organization}`,
  `[Ii]ch bin bei ${article}${organization}[ \\t]+(?:angestellt|tätig|beschäftigt)`,
  `[Uu]nser(?:e|em|er)? (?:Firma|Unternehmen|Betrieb|Arbeitgeber|Büro|Praxis|Kanzlei|Organisation|Verwaltung|Gemeinde)(?: heisst| ist|:|,)? ${article}${organization}`,
  `[Mm]ein(?:e|em|er)? (?:Firma|Arbeitgeber|Unternehmen|Betrieb|Praxis|Kanzlei)(?: heisst| ist|:|,)? ${article}${organization}`,
  `[Ww]ir sind ${article}${organization}`,
  `I (?:work|am employed)[ \\t]+(?:at|by)[ \\t]+${article}${organization}`,
  `[Oo]ur (?:company|firm|business|practice|office)(?: is| called|:|,)? ${article}${organization}`,
].map((pattern) => new RegExp(`(?<![\\p{L}\\p{N}])${pattern}`, 'gu'));

/** Leading words that describe someone the user works for or deals with, not the employer. */
const notOwnOrganization =
  /^(?:kunde|kundin|kunden|projekt|herr|frau|familie|mandant|mandantin|client|customer|mitglied|gast)\b/u;
const legalForm =
  /\b(?:ag|gmbh|sa|sarl|kg|kgaa|ohg|gbr|ltd|llc|inc|plc|se|eg|genossenschaft|verein|stiftung)\b/gu;

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

/** Own organisation names stated in the user's own texts, in comparable form. */
export function ownBrainOrganizations(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const pattern of ownOrganizationPatterns) {
      for (const match of text.matchAll(pattern)) {
        const name = core(match[1] ?? '');
        if (name.length >= 3 && !notOwnOrganization.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/** True when the scope only names the user's own organisation. */
export function isOwnBrainOrganizationScope(scope: string, organizations: string[]): boolean {
  const value = core(scope);
  if (value.length < 3) return false;
  return organizations.some(
    (name) =>
      value === name ||
      ` ${value} `.includes(` ${name} `) ||
      (value.length >= 4 && ` ${name} `.includes(` ${value} `)),
  );
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
