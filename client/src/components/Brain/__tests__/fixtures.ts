import type { BrainGraph, BrainNode, BrainRebuildStatus } from 'librechat-data-provider';

export function rebuildFixture(status: 'building' | 'ready' = 'building'): BrainRebuildStatus {
  return {
    rebuild: {
      id: 'rebuild-one',
      status,
      createdAt: '2026-09-14T10:00:00Z',
      revision: 7,
      counts: { current: 4, staged: 2, preserved: 1, retired: 3 },
      preview: { added: [memory()], retired: [memory({ id: 'old-node', title: 'Old fragment' })] },
      previewTruncated: false,
    },
    rollbackAvailable: false,
  };
}

export function memory(overrides: Partial<BrainNode> = {}): BrainNode {
  return {
    id: 'node-one',
    title: 'Projekt Abendrot',
    text: 'Der Pilot startet mit drei Arbeitsplätzen.',
    kind: 'project',
    scope: 'Abendrot',
    tags: ['pilot'],
    status: 'active',
    confidence: 'derived',
    pinned: false,
    version: 1,
    createdAt: '2026-09-14T10:00:00Z',
    updatedAt: '2026-09-14T10:00:00Z',
    sources: [
      {
        id: 'source-one',
        type: 'chat',
        conversationId: 'chat-one',
        messageId: 'message-one',
        label: 'Pilot planen',
        excerpt: 'Wir beginnen mit drei Arbeitsplätzen.',
        createdAt: '2026-09-14T10:00:00Z',
      },
    ],
    ...overrides,
  };
}

export const graphFixture: BrainGraph = {
  nodes: [
    memory(),
    memory({
      id: 'node-two',
      title: 'Kurze Antworten',
      text: 'Antworten bitte kurz und auf Deutsch.',
      kind: 'preference',
      scope: null,
      confidence: 'confirmed',
      sources: [],
    }),
  ],
  edges: [{ id: 'edge-one', from: 'node-one', to: 'node-two', label: 'bevorzugt' }],
  total: 2,
  nextCursor: null,
};
