import { createHash } from 'node:crypto';
import type { BrainReviewCheckpoint } from './review';
import type { BrainConversationMessage } from './conversation';
import type { BrainNode } from 'librechat-data-provider';

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 64;
const runs = new Map<string, { controller: AbortController; touched: number }>();
export interface BrainOngoingCheckpoint {
  fingerprint: string;
  sources: string[];
  checkpoint: BrainReviewCheckpoint;
  saved: string[];
  nodes: Pick<BrainNode, 'id' | 'text' | 'version'>[];
  touched: number;
}
const checkpoints = new Map<string, BrainOngoingCheckpoint>();
export const brainConversationKey = (userId: string, conversationId: string): string =>
  `${userId}:${conversationId}`;
export const brainSourceFingerprint = (message: BrainConversationMessage): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        message.id,
        message.parentId,
        message.role,
        message.contentHash,
        message.createdAt,
      ]),
    )
    .digest('hex');

export function registerBrainTurn(userId: string, conversationId: string): AbortSignal {
  const key = brainConversationKey(userId, conversationId);
  runs
    .get(key)
    ?.controller.abort(new Error('Ein neuerer Gesprächsschritt übernimmt das Brain-Lernen.'));
  const controller = new AbortController();
  runs.delete(key);
  runs.set(key, { controller, touched: Date.now() });
  for (const [id, run] of runs) {
    if (runs.size > MAX_ENTRIES || Date.now() - run.touched > TTL_MS) {
      run.controller.abort(new Error('Der Brain-Lernlauf ist abgelaufen.'));
      runs.delete(id);
    }
  }
  return controller.signal;
}

export function clearBrainOngoingCheckpoint(key: string): void {
  checkpoints.delete(key);
}
export function readBrainOngoingCheckpoint(
  key: string,
  fingerprint: string,
  sources: string[],
): BrainOngoingCheckpoint | undefined {
  const previous = checkpoints.get(key);
  if (!previous) return undefined;
  if (
    Date.now() - previous.touched > TTL_MS ||
    previous.fingerprint !== fingerprint ||
    previous.sources.length > sources.length ||
    previous.sources.some((source, index) => sources[index] !== source)
  ) {
    checkpoints.delete(key);
    return undefined;
  }
  return structuredClone(previous);
}
export function saveBrainOngoingCheckpoint(
  key: string,
  value: Omit<BrainOngoingCheckpoint, 'touched'>,
): void {
  const entry = { ...value, touched: Date.now() };
  checkpoints.delete(key);
  if (JSON.stringify(entry).length > 250000) return;
  checkpoints.set(key, structuredClone(entry));
  while (checkpoints.size > MAX_ENTRIES) checkpoints.delete(checkpoints.keys().next().value!);
}
