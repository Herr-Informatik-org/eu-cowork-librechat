interface RecallMessage {
  text: string;
  role: 'user' | 'assistant';
}

const externalBlocks = /\[(KONTEXT|DOKUMENT)(?::[^\]]*)?\][\s\S]*?\[\/\1\]/giu;
const requestBlock = /\[USER-REQUEST\]\s*([\s\S]*?)\s*\[\/USER-REQUEST\]/u;
const reviewRequest = /\[MAIL-REVIEW-REQUEST\]\s*([^\n]+)\s*\[\/MAIL-REVIEW-REQUEST\]/u;

/** Keep external source text out of the user-evidence boundary without changing original hashes. */
export function brainAuthoredText(text: string): string {
  let authored = text;
  for (const kind of ['KONTEXT', 'DOKUMENT', 'PERSÖNLICHE STILVORGABEN']) {
    const opening = new RegExp(`(?:^|\\n)\\[${kind}(?::[^\\]\\n]*)?\\]`, 'u');
    const start = opening.exec(authored)?.index;
    if (start === undefined) continue;
    // Legacy raw mail can contain forged closing markers. Keep the whole region foreign.
    const closings = [...authored.matchAll(new RegExp(`(?:^|\\n)\\[/${kind}\\]`, 'gu'))];
    const last = closings[closings.length - 1];
    authored =
      authored.slice(0, start) +
      (last && last.index >= start ? authored.slice(last.index + last[0].length) : '');
  }
  // Older mail handoffs did not carry structured source markers.
  const legacy = authored.indexOf('\nOriginalmail:\n');
  if (legacy >= 0) authored = authored.slice(0, legacy);
  authored = authored.replace(
    /(?:^|\n)\[MAIL-REVIEW-REQUEST\]\r?\n([^\n]*)\r?\n\[\/MAIL-REVIEW-REQUEST\]/gu,
    (_block, json: string) => {
      try {
        const parsed: { text?: unknown } = JSON.parse(json);
        return typeof parsed.text === 'string' ? `\n${parsed.text}\n` : '';
      } catch {
        return '';
      }
    },
  );
  const incompleteReview = authored.indexOf('[MAIL-REVIEW-REQUEST]');
  if (incompleteReview >= 0) authored = authored.slice(0, incompleteReview);
  return requestBlock.exec(authored)?.[1] ?? authored;
}

function userRequest(text: string): string {
  const ownText = brainAuthoredText(text);
  const explicit = requestBlock.exec(ownText)?.[1];
  if (explicit) return explicit;
  const review = reviewRequest.exec(ownText)?.[1];
  if (review) {
    try {
      const parsed: { text?: string } = JSON.parse(review);
      if (typeof parsed.text === 'string') return parsed.text;
    } catch {
      // Invalid markers remain plain source data.
    }
  }
  let authored = ownText
    .replace(/\[PERSÖNLICHE STILVORGABEN[^\]]*\][\s\S]*?\[\/PERSÖNLICHE STILVORGABEN\]/gu, '')
    .trim();
  if (text.startsWith('Du bist der KI-Assistent im Outlook-Seitenbereich.')) {
    const paragraphs = authored.split(/\n\s*\n/u);
    authored = paragraphs[paragraphs.length - 1] ?? authored;
  }
  return authored;
}

function bounded(text: string, limit: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean.length <= limit) return clean;
  // Keep the trailing task inside the lexical search's first terms as well as semantic search.
  const tail = Math.min(320, Math.floor(limit * 0.45));
  return `${clean.slice(-tail)} ${clean.slice(0, limit - tail - 1)}`;
}

/** Retrieval uses the actual task first; earlier turns only disambiguate short follow-ups. */
export function buildBrainRecallQuery({
  text,
  previousMessages = [],
}: {
  text: string;
  previousMessages?: RecallMessage[];
}): string {
  const request = userRequest(text);
  const followup =
    request.length < 180 ||
    /\b(das|dazu|damit|davon|dies(?:e|es|en)?|weiter|it|that|those|same)\b/iu.test(request);
  const previous = followup
    ? previousMessages
        .slice(-4)
        .reverse()
        .map((message) => bounded(userRequest(message.text), 650))
    : [];
  const external = [...text.matchAll(externalBlocks)].map((match) => bounded(match[0], 700));
  return (
    [bounded(request, 2600), ...previous, ...external.slice(0, 2)]
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000) || 'Persönliche Arbeitsweisen und Präferenzen'
  );
}
