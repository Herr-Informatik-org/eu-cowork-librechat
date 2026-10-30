import { z } from 'zod';
import type { BrainNode, BrainUsage, BrainUsageItem } from 'librechat-data-provider';

export const brainUsageSchema: z.ZodType<BrainUsage> = z
  .object({
    status: z.enum(['available', 'empty', 'disabled', 'unavailable']),
    count: z.number().int().min(0),
    items: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            text: z.string().max(2400).optional(),
            kind: z.enum(['preference', 'project', 'person', 'decision', 'fact', 'procedure']),
            scope: z.string().nullable(),
            status: z.enum(['active', 'superseded', 'uncertain']).optional(),
            basis: z.enum(['direct', 'confirmed', 'derived']).optional(),
            claimState: z.enum(['stated', 'agreed', 'planned', 'completed', 'revoked']).optional(),
            validFrom: z.string().optional(),
            validUntil: z.string().optional(),
            updatedAt: z.string().optional(),
            textTruncated: z.boolean().optional(),
            sources: z.array(
              z
                .object({
                  type: z.enum(['chat', 'manual', 'memory']),
                  conversationId: z.string().optional(),
                  sourceMessageId: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export function brainUsageItem(node: BrainNode): BrainUsageItem {
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    scope: node.scope,
    text: node.text.slice(0, 2400),
    ...(node.text.length > 2400 ? { textTruncated: true } : {}),
    status: node.status,
    basis: node.basis,
    claimState: node.claimState,
    validFrom: node.validFrom ?? undefined,
    validUntil: node.validUntil ?? undefined,
    updatedAt: node.updatedAt,
    sources: node.sources.map(({ type, conversationId, messageId }) => ({
      type,
      conversationId,
      sourceMessageId: messageId,
    })),
  };
}
