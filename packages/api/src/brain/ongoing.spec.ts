import {
  brainConversationKey,
  brainSourceFingerprint,
  clearBrainOngoingCheckpoint,
  readBrainOngoingCheckpoint,
  registerBrainTurn,
  saveBrainOngoingCheckpoint,
} from './ongoing';
import { conversationMessages } from './conversation';

const message = conversationMessages([
  {
    conversationId: 'conversation',
    messageId: 'm',
    text: 'Projekt Atlas',
    isCreatedByUser: true,
    createdAt: '2026-09-14',
  },
])[0];
const key = brainConversationKey('owner', 'conversation');
const value = {
  fingerprint: 'config',
  sources: ['a'],
  checkpoint: { position: 1, phase: 'done' as const, candidates: [] },
  saved: [],
  nodes: [],
};
afterEach(() => {
  clearBrainOngoingCheckpoint(key);
  jest.restoreAllMocks();
});

describe('bounded ongoing Brain checkpoints', () => {
  it('retains only unchanged owned prefixes and invalidates changed configuration or branches', () => {
    saveBrainOngoingCheckpoint(key, value);
    expect(readBrainOngoingCheckpoint(key, 'config', ['a', 'b'])).toMatchObject(value);
    expect(readBrainOngoingCheckpoint(key, 'different', ['a'])).toBeUndefined();
    saveBrainOngoingCheckpoint(key, value);
    expect(readBrainOngoingCheckpoint(key, 'config', ['changed'])).toBeUndefined();
    saveBrainOngoingCheckpoint(key, value);
    expect(readBrainOngoingCheckpoint(key, 'config', [])).toBeUndefined();
    expect(
      readBrainOngoingCheckpoint(brainConversationKey('other', 'conversation'), 'config', ['a']),
    ).toBeUndefined();
  });
  it('invalidates changed role, parent or content and expires cached plaintext', () => {
    const hash = brainSourceFingerprint(message);
    for (const changed of [
      { role: 'assistant' as const },
      { parentId: 'other' },
      { contentHash: 'edited' },
    ]) {
      expect(brainSourceFingerprint({ ...message, ...changed })).not.toBe(hash);
    }
    saveBrainOngoingCheckpoint(key, value);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    expect(readBrainOngoingCheckpoint(key, 'config', ['a'])).toBeUndefined();
  });
  it('cancels earlier turns only for the same owner and conversation', () => {
    const first = registerBrainTurn('owner', 'conversation');
    const other = registerBrainTurn('other', 'conversation');
    const latest = registerBrainTurn('owner', 'conversation');
    expect(first.aborted).toBe(true);
    expect(other.aborted).toBe(false);
    expect(latest.aborted).toBe(false);
  });
});
