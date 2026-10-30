import { createHash } from 'node:crypto';
import type { BrainCandidate } from './session';
import type { BrainConversationMessage } from './conversation';
import { brainAuthoredText } from './query';

export const brainScopeInstructions = `Personal preferences have a precise scope: omit scope for genuinely general user preferences; use "Mail" for email-wide preferences; use "Mail: lower-case@email.address" only for an explicitly named contact; preserve the verbatim project name for project-only rules. A project/customer example does not restrict an explicitly general rule, and an isolated task or draft edit does not establish any durable preference. Do not invent an expiry, review date, start date or distant placeholder date. Omit validFrom and validUntil for timeless preferences. Add them only when the user's evidence states the actual date or a resolvable relative date. An assistant date, message timestamp or model-generated default is never sufficient evidence.`;

export function personalMailScope(sender: string): string {
  const address = sender.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) || address.length > 254)
    throw new Error('Die Kontaktadresse ist ungültig.');
  return `Mail: ${address.length <= 150 ? address : createHash('sha256').update(address).digest('hex')}`;
}

const mailWords = /\b(?:(?:e-?)?mails?|mailantwort\w*|email\w*)\b/i;
const globalWords =
  /\b(?:generell|grundsätzlich|grundsaetzlich|allgemein|überall|ueberall|in allen (?:antworten|chats)|generally|all responses)\b/i;
const transientWords =
  /\b(?:nur (?:heute|morgen|diese Woche|diesen Monat|dies(?:e|er|en|es)|für diese)|heute (?:bitte|antworte)|diesmal|einmalig|in (?:dieser|der vorliegenden) (?:mail|antwort)|for this (?:mail|email|reply)|just this time)\b/i;

/** Scope and time metadata must come from authored evidence, never third-party source blocks. */
export function qualifyBrainCandidate(
  fact: BrainCandidate,
  messages: Pick<BrainConversationMessage, 'id' | 'text' | 'role' | 'createdAt'>[],
): BrainCandidate | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const evidence = (fact.evidence ?? []).flatMap((entry) => {
    const message = byId.get(entry.messageId);
    return message?.role === 'user' && brainAuthoredText(message.text).includes(entry.quote)
      ? [{ text: entry.quote, createdAt: message.createdAt }]
      : [];
  });
  const authored = evidence.map((entry) => entry.text).join('\n');
  const result = { ...fact };
  if (fact.kind === 'preference') {
    if (transientWords.test(authored)) return;
    const address = authored.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    if (fact.scope?.startsWith('Mail:')) {
      if (
        !address ||
        personalMailScope(address) !==
          fact.scope
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
    } else if (mailWords.test(authored) && (!fact.scope || /^e?-?mails?$/i.test(fact.scope))) {
      result.scope = 'Mail';
    } else if (fact.scope && !authored.includes(fact.scope)) {
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
