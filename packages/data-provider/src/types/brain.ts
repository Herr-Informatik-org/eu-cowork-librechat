export type BrainKind = 'preference' | 'project' | 'person' | 'decision' | 'fact' | 'procedure';

export type BrainSource = {
  id: string;
  type: 'chat' | 'manual' | 'memory';
  conversationId?: string;
  messageId?: string;
  label: string;
  excerpt: string;
  createdAt: string;
};

export type BrainNode = {
  id: string;
  title: string;
  text: string;
  kind: BrainKind;
  scope: string | null;
  tags: string[];
  status: 'active' | 'superseded' | 'uncertain';
  confidence: 'confirmed' | 'derived';
  pinned: boolean;
  sources: BrainSource[];
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type BrainEdge = { id: string; from: string; to: string; label: string };

export type BrainGraph = {
  nodes: BrainNode[];
  edges: BrainEdge[];
  total: number;
  nextCursor: string | null;
};

export type BrainGraphParams = { query?: string; scope?: string; cursor?: string; limit?: number };

export type BrainRecall = {
  id: string;
  conversationId?: string;
  messageId?: string;
  nodeIds: string[];
  query: string;
  estimatedTokens: number;
  hasMore: boolean;
  stopReason: string;
  createdAt: string;
};

export type BrainNodeInput = Pick<BrainNode, 'title' | 'text' | 'kind'> &
  Partial<Pick<BrainNode, 'scope' | 'tags' | 'pinned'>> & { relatedIds?: string[] };

export type BrainNodeUpdate = Partial<BrainNodeInput> & {
  status?: BrainNode['status'];
  version: number;
};

export type BrainExport = {
  schemaVersion: 1;
  exportedAt: string;
  nodes: BrainNode[];
  edges: BrainEdge[];
};

export type BrainHistoryStatus = {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  error?: string;
  modelLabel?: string;
  available: boolean;
  reason?: string;
};
