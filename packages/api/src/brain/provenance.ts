import type { BrainConversationMessage } from './conversation';
import { conversationHash } from './conversation';
import { BrainOperationError } from './diagnostics';
import { requestBrain } from './client';

type SourceMetadata = Pick<BrainConversationMessage, 'id' | 'role' | 'createdAt' | 'contentHash'>;

interface BrainSourceManifest {
  id: string;
  conversationId: string;
  generationId?: string;
  sourceMessages: SourceMetadata[];
}

/** Canonical key order is shared with the service's immutable manifest digest. */
export function createBrainSourceManifest(
  conversationId: string,
  generationId: string | undefined,
  messages: BrainConversationMessage[],
): BrainSourceManifest {
  const sourceMessages = messages.map(({ id, role, createdAt, contentHash }) => ({
    id,
    role,
    createdAt,
    contentHash,
  }));
  const input = { conversationId, generationId, sourceMessages };
  return { id: conversationHash(JSON.stringify(input)), ...input };
}

/** Register every interpreted source once; retries reuse exactly the same immutable pages. */
export async function registerBrainSourceManifest(
  ownerId: string,
  manifest: BrainSourceManifest,
  canContinue: () => Promise<boolean>,
): Promise<void> {
  const pageSize = 500;
  const pageCount = Math.ceil(manifest.sourceMessages.length / pageSize);
  const assertCurrent = async () => {
    if (!(await canContinue()))
      throw new BrainOperationError('Gespräch oder Berechtigung wurde inzwischen geändert.');
  };
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    await assertCurrent();
    await requestBrain(
      ownerId,
      'POST',
      `/v1/source-manifests/${manifest.id}/pages/${pageIndex}`,
      {
        conversationId: manifest.conversationId,
        generationId: manifest.generationId,
        pageCount,
        sourceCount: manifest.sourceMessages.length,
        sourceMessages: manifest.sourceMessages.slice(
          pageIndex * pageSize,
          (pageIndex + 1) * pageSize,
        ),
      },
      120_000,
    );
  }
  await assertCurrent();
  await requestBrain(ownerId, 'POST', `/v1/source-manifests/${manifest.id}/complete`, {}, 120_000);
}
