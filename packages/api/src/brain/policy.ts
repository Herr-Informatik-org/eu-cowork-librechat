import { createHash } from 'node:crypto';
import type { BrainCandidate } from './session';
import type { BrainConversationMessage } from './conversation';
import { brainAuthoredText } from './query';

export const brainScopeInstructions = `Personal preferences have a precise scope: omit scope for genuinely general user preferences; use "Mail" for email-wide preferences; use "Mail: lower-case@email.address" only for an explicitly named contact; preserve the verbatim project name for project-only rules. The user's own company or employer is never a scope: own role, writing style and own prices or rates apply everywhere and stay unscoped. A project/customer example does not restrict an explicitly general rule, and an isolated task or draft edit does not establish any durable preference. Do not invent an expiry, review date, start date or distant placeholder date. Omit validFrom and validUntil for timeless preferences. Add them only when the user's evidence states the actual date or a resolvable relative date. An assistant date, message timestamp or model-generated default is never sufficient evidence.`;

export function personalMailScope(sender: string): string {
  const address = sender.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) || address.length > 254)
    throw new Error('Die Kontaktadresse ist ungültig.');
  return `Mail: ${address.length <= 150 ? address : createHash('sha256').update(address).digest('hex')}`;
}

/** Derive contact applicability only from the current authored mail task, never a model query. */
export function brainMailApplicableScopes(text: string): string[] {
  const authored = brainAuthoredText(text);
  const replyTask = /\b(?:antworte|beantworte|antworten|beantworten|reply|respond)\b/i.test(
    authored,
  );
  const mailTask =
    /\b(?:schreibe|schreib|schreiben|formuliere|verfasse|entwirf|write|compose|draft)\b/i.test(
      authored,
    ) && /\b(?:(?:e-?)?mails?|emails?|antwort|reply)\b/i.test(authored);
  if (!replyTask && !mailTask) return [];
  const addresses = [
    ...new Set(
      (authored.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map(
        (address) => address.toLowerCase(),
      ),
    ),
  ];
  if (addresses.length !== 1) return [];
  try {
    return [personalMailScope(addresses[0]), 'Mail'];
  } catch {
    return [];
  }
}

const mailWords = /\b(?:(?:e-?)?mails?|mailantwort\w*|email\w*)\b/i;
const globalWords =
  /\b(?:generell|grundsätzlich|grundsaetzlich|allgemein|überall|ueberall|in allen (?:antworten|chats)|generally|all responses)\b/i;
const transientWords =
  /\b(?:nur (?:heute|morgen|diese Woche|diesen Monat|dies(?:e|er|en|es)|für diese)|heute (?:bitte|antworte)|diesmal|einmalig|in (?:dieser|der vorliegenden) (?:mail|antwort)|for this (?:mail|email|reply)|just this time)\b/i;

/**
 * Own organisation: a Brain scope separates work for customers and projects. The user's
 * own employer is not such a context: own role, writing style and own rates apply to
 * every task and belong in the unscoped profile. Models nevertheless tend to scope them
 * with the own company name, which hides a style rule from the always-on profile.
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

/**
 * Scope and time metadata must come from authored evidence, never third-party source blocks.
 * A scope naming the user's own employer in that evidence is dropped before the other rules.
 */
export function qualifyBrainCandidate(
  fact: BrainCandidate,
  messages: Pick<BrainConversationMessage, 'id' | 'text' | 'role' | 'createdAt'>[],
): BrainCandidate | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const evidence = (fact.evidence ?? []).flatMap((entry) => {
    const message = byId.get(entry.messageId);
    return message?.role === 'user' && brainAuthoredText(message.text).includes(entry.quote)
      ? [{ text: entry.quote, createdAt: message.createdAt, message: message.text }]
      : [];
  });
  const authored = evidence.map((entry) => entry.text).join('\n');
  const result = { ...fact };
  if (
    result.scope &&
    isOwnBrainOrganizationScope(
      result.scope,
      [...new Set(evidence.map((entry) => entry.message))].flatMap(ownBrainOrganizations),
    )
  ) {
    delete result.scope;
  }
  if (fact.kind === 'preference') {
    if (transientWords.test(authored)) return;
    const address = authored.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (result.scope?.startsWith('Mail:')) {
      if (
        !address ||
        personalMailScope(address) !==
          result.scope
            .trim()
            .toLowerCase()
            .replace(/^mail:/, 'Mail:')
      )
        return;
      result.scope = personalMailScope(address);
    } else if (address && mailWords.test(authored) && !globalWords.test(authored)) {
      result.scope = personalMailScope(address);
    } else if (
      globalWords.test(authored) &&
      !mailWords.test(authored) &&
      !/\b(?:für|im|beim|bei|for|in) (?:projekt|kunde|project|customer)\b/i.test(authored)
    ) {
      delete result.scope;
    } else if (mailWords.test(authored) && (!result.scope || /^e?-?mails?$/i.test(result.scope))) {
      result.scope = 'Mail';
    } else if (result.scope && !authored.includes(result.scope)) {
      return;
    }
  }
  for (const field of ['validFrom', 'validUntil'] as const) {
    const value = result[field];
    if (!value) continue;
    if (
      !evidence.some((source) => supportsBrainDate(value, source.text, source.createdAt, field))
    ) {
      if (hasExplicitTime(authored, field)) return;
      delete result[field];
    }
  }
  if (
    ['validFrom', 'validUntil'].some(
      (field) =>
        !result[field as 'validFrom' | 'validUntil'] &&
        hasExplicitTime(authored, field as 'validFrom' | 'validUntil'),
    )
  )
    return;
  if (
    result.validFrom &&
    result.validUntil &&
    Date.parse(result.validFrom) >= Date.parse(result.validUntil)
  )
    return;
  return result;
}

function hasExplicitTime(text: string, field: 'validFrom' | 'validUntil'): boolean {
  const boundary = field === 'validUntil' ? '(?:bis|until)' : '(?:ab|seit|from)';
  return new RegExp(
    `\\b${boundary}\\s+(?:(?:zum|zur|dem)\\s+)?(?:\\d|heute|morgen|übermorgen|uebermorgen|today|tomorrow|ende|mitte|anfang|nächste|naechste|diese|next|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)`,
    'i',
  ).test(text);
}

function supportsBrainDate(
  value: string,
  text: string,
  createdAt: string,
  field: 'validFrom' | 'validUntil',
): boolean {
  if (
    !(
      field === 'validUntil'
        ? /\b(?:bis|until|endet|endend|befristet|expires)\b/i
        : /\b(?:ab|seit|from|starting|beginnend)\b/i
    ).test(text)
  )
    return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() >= 9999) return false;
  const day = date.toISOString().slice(0, 10);
  const boundary =
    field === 'validUntil'
      ? /\b(?:bis|until|endet|endend|befristet|expires)\s+/i
      : /\b(?:ab|seit|from|starting|beginnend)\s+/i;
  const position = boundary.exec(text);
  if (!position) return false;
  const following = text.slice(position.index + position[0].length);
  const stated =
    /^(?:(?:zum|zur|dem)\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|heute|morgen|übermorgen|uebermorgen|today|tomorrow)\b/i.exec(
      following,
    )?.[1];
  if (!stated) return false;
  if (/^\d{4}-/.test(stated)) return stated === day;
  const numeric = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(stated);
  if (numeric)
    return `${numeric[3]}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}` === day;
  const relative = stated.toLowerCase();
  const source = new Date(createdAt);
  if (!Number.isFinite(source.getTime())) return false;
  const dayOffsets: Record<string, number> = {
    heute: 0,
    today: 0,
    morgen: 1,
    tomorrow: 1,
    übermorgen: 2,
    uebermorgen: 2,
  };
  source.setUTCDate(source.getUTCDate() + dayOffsets[relative]);
  return source.toISOString().slice(0, 10) === day;
}

export interface PersonalMailRule {
  text: string;
  scope: 'sender' | 'global';
}

/** Only the current, self-contained authored command is eligible; history and draft text are not. */
export function explicitPersonalMailRule(
  text: string,
  sender?: string,
): PersonalMailRule | undefined {
  const authored = brainAuthoredText(text).trim();
  if (
    authored !== text.trim() ||
    authored.length < 12 ||
    authored.length > 2400 ||
    /[?"“”«»]/.test(authored) ||
    transientWords.test(authored)
  )
    return;
  if (/\b(?:nicht (?:merken|speichern)|merke (?:dir )?nicht|do not remember)\b/i.test(authored))
    return;
  if (
    /\b(?:zitat|quote|weitergeleitet|schreibt|sagt|laut (?:der|dem|dieser|diesem))\b/i.test(
      authored,
    )
  )
    return;
  if (
    hasExplicitTime(authored, 'validFrom') ||
    hasExplicitTime(authored, 'validUntil') ||
    /\b(?:projekt|project)\b/i.test(authored)
  )
    return;
  const namedAddress = authored.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (namedAddress && namedAddress.toLowerCase() !== sender?.trim().toLowerCase()) return;
  if (
    !namedAddress &&
    /(?:\b(?:[Aa]ntworte|[Ss]chreibe|[Bb]eantworte)\s+(?!Mails?\b|E-Mails?\b|Emails?\b|Antwort(?:en)?\b|Nachrichten\b)[A-ZÄÖÜ][\p{L}-]+|\b(?:[Aa]n|[Ff]ür|[Bb]ei|[Vv]on)\s+(?:(?:den|dem)\s+)?(?:(?:Kunde[n]?|Kontakt|Herrn?|Frau)\s+)?(?!Mails?\b|E-Mails?\b|Emails?\b|Antwort(?:en)?\b|Nachrichten\b)[A-ZÄÖÜ][\p{L}-]+)/u.test(
      authored,
    )
  )
    return;
  const durable =
    /\b(?:merke (?:dir|bitte)|behalte|künftig|kuenftig|zukünftig|ab jetzt|von nun an|grundsätzlich|immer|remember|from now on|always)\b/i.test(
      authored,
    );
  const selfContained =
    /\b(?:gedankenstrich\w*|stichpunkt\w*|aufzähl\w*|kurz|knapp|ausführlich|beantwort\w*|antwort\w*|schreib\w*|formulier\w*|anrede|duzen|siezen|begrüss\w*|signatur\w*|tonfall|reply|responses?|write|salutation)\b/i.test(
      authored,
    );
  if (
    !durable ||
    !selfContained ||
    /\b(?:merke dir (?:das|dies|diesen stil)|wie (?:oben|zuvor|bisher))\b/i.test(authored)
  )
    return;
  const contact =
    !!namedAddress ||
    /\b(?:dies(?:em|en|er) (?:kontakt|kunden|absender)|für (?:diesen|diese)|bei (?:diesem|dieser))\b/i.test(
      authored,
    );
  const general =
    globalWords.test(authored) ||
    /\b(?:alle[nr]? (?:(?:e-?)?mails?|mailantworten)|all (?:emails?|mail|replies))\b/i.test(
      authored,
    );
  return { text: authored, scope: contact && !general ? 'sender' : 'global' };
}
