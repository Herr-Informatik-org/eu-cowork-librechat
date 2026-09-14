import type { BrainCandidate } from './session';
import type { BrainConversationMessage } from './conversation';
import { compatibleBrainEvidence } from './conversation';
import { containsBrainCredential } from './safety';

export function validateContextualFacts(
  candidates: BrainCandidate[],
  messages: BrainConversationMessage[],
  knownIds: ReadonlySet<string> = new Set(),
): BrainCandidate[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return candidates
    .filter((fact) => {
      if (!fact.text || !fact.evidence?.length || containsBrainCredential(fact.text)) return false;
      if (fact.supersedesId && !knownIds.has(fact.supersedesId)) return false;
      if (fact.validFrom && fact.validUntil && fact.validFrom > fact.validUntil) return false;
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
          !message.text.includes(evidence.quote) ||
          containsBrainCredential(evidence.quote)
        )
          return false;
        if (message.role === 'user') hasUser = true;
      }
      return hasUser;
    })
    .map((fact) => ({ ...fact, relatedIds: fact.relatedIds?.filter((id) => knownIds.has(id)) }));
}
