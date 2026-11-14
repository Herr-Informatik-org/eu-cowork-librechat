import { qualifyBrainCandidate } from './policy';
import type { BrainCandidate } from './session';
import type { BrainConversationMessage } from './conversation';
import { compatibleBrainEvidence } from './conversation';
import { containsBrainCredential } from './safety';
import { brainAuthoredText } from './query';
import { isSafeWorkEnabled } from '~/agents/safeWork';

/** A memory command is not evidence for technical fields invented by the assistant. */
export function hasAuthoredBrainSupport(
  fact: BrainCandidate,
  messages: BrainConversationMessage[],
): boolean {
  if (!isSafeWorkEnabled()) return true;
  const userEvidence = (fact.evidence ?? [])
    .flatMap((evidence) => {
      const source = messages.find(
        (message) => message.id === evidence.messageId && message.role === 'user',
      );
      return source && brainAuthoredText(source.text).includes(evidence.quote)
        ? [evidence.quote]
        : [];
    })
    .join('\n');
  if (!userEvidence.trim()) return false;
  const anchors = fact.text?.match(/`[^`\n]{2,160}`|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g) ?? [];
  if (anchors.some((anchor) => !userEvidence.includes(anchor.replace(/^`|`$/g, '')))) return false;
  const numbers = fact.text?.match(/\b\d+(?:[.,]\d+)*\b/g) ?? [];
  if (numbers.some((number) => !userEvidence.includes(number))) return false;
  const stripped = userEvidence
    .replace(
      /\b(?:bitte|merke|merk|merken|dir|das|dies|diese|im|in|brain|wie|man|es|sich|richtig|korrekt|hinterlegt|remember|this|that|please)\b/gi,
      '',
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return stripped.split(/\s+/).filter((word) => word.length > 2).length >= 3;
}

function storageText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0')
  );
}

/** Repair invalid metadata on resume; preserve valid wire values and their existing request IDs. */
function normalizeCandidate(fact: BrainCandidate): BrainCandidate | undefined {
  if (!storageText(fact.text, 12000)) return;
  const result: BrainCandidate = { ...fact };
  if (fact.title != null) {
    result.title = fact.title.trim() ? fact.title : fact.text.trim().slice(0, 160);
    if (!storageText(result.title, 160)) return;
  }
  if (fact.tags != null) {
    result.tags = fact.tags.filter((tag) => tag.trim());
    if (result.tags.length > 20 || result.tags.some((tag) => !storageText(tag, 80))) return;
  }
  if (fact.scope?.trim() && !storageText(fact.scope, 160)) return;
  if (fact.supersedesId != null && !fact.supersedesId.trim()) delete result.supersedesId;
  if (
    result.supersedesId &&
    (!storageText(result.supersedesId, 200) || /[\r\n]/.test(result.supersedesId))
  )
    return;
  if (
    fact.expectedVersion !== undefined &&
    (!result.supersedesId ||
      !Number.isSafeInteger(fact.expectedVersion) ||
      fact.expectedVersion < 1)
  )
    return;

  for (const key of ['validFrom', 'validUntil'] as const) {
    const value = fact[key];
    if (value == null) continue;
    if (!value.trim()) {
      delete result[key];
      continue;
    }
    // Never drop a nonempty invalid time qualification and turn it into a timeless claim.
    const timestamp = Date.parse(value.trim());
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value.trim()) || !Number.isFinite(timestamp)) return;
    if (value.length > 40) result[key] = new Date(timestamp).toISOString();
  }
  if (
    result.validFrom &&
    result.validUntil &&
    Date.parse(result.validFrom.trim()) >= Date.parse(result.validUntil.trim())
  )
    return;
  return result;
}

export function validateContextualFacts(
  candidates: BrainCandidate[],
  messages: BrainConversationMessage[],
  knownIds: ReadonlySet<string> = new Set(),
): BrainCandidate[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return candidates
    .map(normalizeCandidate)
    .filter((fact): fact is BrainCandidate => fact !== undefined)
    .filter((fact) => {
      if (!fact.text || !fact.evidence?.length || containsBrainCredential(fact.text)) return false;
      if (fact.supersedesId && !knownIds.has(fact.supersedesId)) return false;
      if (fact.evidence.length > 40) return false;
      if (
        !compatibleBrainEvidence(
          fact.evidence.map((entry) => entry.messageId),
          messages,
        )
      )
        return false;
      let hasUser = false;
      for (const evidence of fact.evidence) {
        const message = byId.get(evidence.messageId);
        if (
          !message ||
          !storageText(evidence.quote, 8000) ||
          !storageText(message.text, Infinity) ||
          !message.text.includes(evidence.quote) ||
          containsBrainCredential(evidence.quote)
        )
          return false;
        if (message.role === 'user') {
          if (!brainAuthoredText(message.text).includes(evidence.quote)) return false;
          hasUser = true;
        }
      }
      return hasUser;
    })
    .filter((fact) => hasAuthoredBrainSupport(fact, messages))
    .map((fact) => qualifyBrainCandidate(fact, messages))
    .filter((fact): fact is BrainCandidate => fact !== undefined)
    .map((fact) => ({ ...fact, relatedIds: fact.relatedIds?.filter((id) => knownIds.has(id)) }));
}
