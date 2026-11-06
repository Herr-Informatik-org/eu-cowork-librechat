export type BrainKind = 'preference' | 'project' | 'person' | 'decision' | 'fact' | 'procedure';

export type BrainSource = {
  id: string;
  type: 'chat' | 'manual' | 'memory';
  conversationId?: string;
  messageId?: string;
  label: string;
  excerpt?: string;
  createdAt: string;
  role?: 'user' | 'assistant';
  contentHash?: string;
  dependency?: boolean;
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
  sourceDependencyCount?: number;
  createdAt: string;
  updatedAt: string;
  version: number;
  claimState?: 'stated' | 'agreed' | 'planned' | 'completed' | 'revoked';
  basis?: 'direct' | 'confirmed' | 'derived';
  validFrom?: string;
  validUntil?: string;
};

export type BrainEdge = { id: string; from: string; to: string; label: string };

export type BrainGraph = {
  nodes: BrainNode[];
  edges: BrainEdge[];
  total: number;
  nextCursor: string | null;
};

export type BrainGraphParams = {
  query?: string;
  scope?: string;
  cursor?: string;
  limit?: number;
  generationId?: string;
};

export type BrainRecall = {
  id: string;
  conversationId?: string;
  messageId?: string;
  nodeIds: string[];
  /** Per-owner digest of the recall query; the query text itself is not retained. */
  queryHash?: string;
  estimatedTokens: number;
  hasMore: boolean;
  stopReason: string;
  createdAt: string;
  diagnostics?: {
    semantic: { status: 'available' | 'degraded' | 'disabled'; repaired: number; pending: boolean };
  };
};

/** Compact view of a memory that an answer drew on. */
export type BrainUsedMemory = Pick<
  BrainNode,
  'id' | 'title' | 'kind' | 'scope' | 'status' | 'confidence' | 'version'
> & {
  sources: Array<Pick<BrainSource, 'type' | 'label' | 'createdAt' | 'conversationId'>>;
};

/** Memories each recorded answer of one conversation drew on. */
export type BrainRecallUsage = {
  messages: Array<{ messageId: string; nodeIds: string[] }>;
  nodes: BrainUsedMemory[];
};

export type BrainLearningStatus = {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' | 'disabled' | 'skipped';
  saved: number;
  /** Sensitive candidates that automatic learning deliberately left unsaved. */
  withheld?: number;
  startedAt?: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  errorCode?: string;
  incidentId?: string;
};

export type BrainNodeInput = Pick<BrainNode, 'title' | 'text' | 'kind'> &
  Partial<Pick<BrainNode, 'scope' | 'tags' | 'pinned'>> & { relatedIds?: string[] };

export type BrainNodeUpdate = Partial<BrainNodeInput> & {
  status?: BrainNode['status'];
  version: number;
};

export type BrainExport = {
  schemaVersion: 1 | 2;
  exportedAt: string;
  nodes: Array<BrainNode & { sourceManifestIds?: string[] }>;
  edges: BrainEdge[];
  sourceManifests?: Array<{
    id: string;
    conversationId: string;
    sourceCount: number;
    pageCount: number;
    pages: Array<{
      pageIndex: number;
      sourceMessages: Array<{
        id: string;
        role: 'user' | 'assistant';
        createdAt: string;
        contentHash: string;
      }>;
    }>;
  }>;
};

export type BrainHistoryStatus = {
  schemaVersion?: 2;
  unit?: 'chats' | 'messages';
  rebuildId?: string;
  autoActivate?: boolean;
  finalizing?: boolean;
  processedSections?: number;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  error?: string;
  errorCode?: string;
  incidentId?: string;
  modelLabel?: string;
  available: boolean;
  reason?: string;
};

export type BrainRebuildStatus = {
  activeGenerationId?: string;
  rebuild: {
    id: string;
    status: 'building' | 'ready';
    createdAt: string;
    revision: number;
    autoActivate?: boolean;
    counts: { current: number; staged: number; preserved: number; retired: number };
    preview: { added: BrainNode[]; retired: BrainNode[] };
    previewTruncated: boolean;
  } | null;
  rollbackAvailable: boolean;
  rollbackUntil?: string;
};
