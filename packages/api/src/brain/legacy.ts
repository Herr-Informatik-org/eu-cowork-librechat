import { createHash } from 'node:crypto';
import type { IMemoryEntryLean } from '@librechat/data-schemas';
import type { BrainFailureReporter } from './diagnostics';
import { classifyBrainFailure } from './diagnostics';
import { requestBrain } from './client';

type LegacyMemory = Pick<IMemoryEntryLean, 'key' | 'value' | 'updated_at' | 'agentId'>;
type LegacyEntry = [key: string, updatedAt: Date | null, valueHash: string];

interface LegacyImportOptions {
  userId: string;
  conversationId: string;
  messageId: string;
  loadMemories: () => Promise<LegacyMemory[]>;
  reportFailure: BrainFailureReporter;
}

const IMPORTED_OWNER_LIMIT = 1000;
/** Runs in the background, so a first import of many memories may take longer than a chat call. */
const LEGACY_IMPORT_TIMEOUT_MS = 30000;
/** Last successfully imported legacy state per owner in this process, least recently used first. */
const importedFingerprints = new Map<string, string>();
const runningImports = new Set<string>();

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function legacyMemoryFingerprint(memories: LegacyMemory[]): string {
  const entries = memories
    .map((memory): LegacyEntry => [memory.key, memory.updated_at ?? null, sha256(memory.value)])
    .sort(([left], [right]) => Number(left > right) - Number(left < right));
  return sha256(JSON.stringify(entries));
}

function rememberImport(userId: string, fingerprint: string): void {
  importedFingerprints.delete(userId);
  importedFingerprints.set(userId, fingerprint);
  if (importedFingerprints.size <= IMPORTED_OWNER_LIMIT) return;
  const oldest = importedFingerprints.keys().next();
  if (!oldest.done) importedFingerprints.delete(oldest.value);
}

async function importChangedMemories({ userId, loadMemories }: LegacyImportOptions): Promise<void> {
  const personal = (await loadMemories()).filter((memory) => !memory.agentId);
  const fingerprint = legacyMemoryFingerprint(personal);
  if (importedFingerprints.get(userId) === fingerprint) {
    rememberImport(userId, fingerprint);
    return;
  }
  if (personal.length > 0) {
    await requestBrain(
      userId,
      'POST',
      '/v1/import',
      {
        memories: personal.map(({ key, value, updated_at }) => ({
          key,
          value,
          updatedAt: updated_at,
        })),
      },
      LEGACY_IMPORT_TIMEOUT_MS,
    );
  }
  rememberImport(userId, fingerprint);
}

/**
 * Carries personal legacy memories into the Brain in the background, once per change and owner.
 * A failed import is reported and retried on a later turn; the chat turn never waits for it.
 */
export function syncLegacyBrainMemories(options: LegacyImportOptions): void {
  const { userId, conversationId, messageId, reportFailure } = options;
  if (runningImports.has(userId)) return;
  runningImports.add(userId);
  void importChangedMemories(options)
    .catch((error: unknown) =>
      reportFailure({
        failure: classifyBrainFailure(error, 'ingest'),
        userId,
        operation: 'recall',
        stage: 'ingest',
        conversationId,
        messageId,
      }).catch(() => undefined),
    )
    .finally(() => runningImports.delete(userId));
}
