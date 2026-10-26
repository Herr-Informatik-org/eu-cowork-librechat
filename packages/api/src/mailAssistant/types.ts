export type MailPriority = 'important' | 'normal' | 'low';
export type MailAction = 'reply' | 'review' | 'information';
export type MailFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;
export const MAIL_CONSENT_VERSION = '2026-10-25';
export const MAIL_CATEGORIES: Record<MailPriority, string> = {
  important: 'KI: Wichtig',
  normal: 'KI: Normal',
  low: 'KI: Niedrig',
};

export interface MailSettings {
  enabled: boolean;
  mode: 'manual' | 'scheduled';
  weekdays: number[];
  startTime: string;
  endTime: string;
  timeZone: string;
  intervalMinutes: 15 | 30 | 60;
  consentVersion?: string;
  history?: { mode: 'off' | 'since' | 'all'; from?: string };
}

export interface MailMessage {
  id: string;
  conversationId: string;
  changeKey: string;
  subject: string;
  sender: string;
  receivedAt: string;
  sentAt?: string;
  body: string;
  bodyTruncated?: boolean;
  etag?: string;
  categories: string[];
  isDraft: boolean;
  sentByUser?: boolean;
  messageUrl?: string;
}

export interface MailAnalysis {
  priority: MailPriority;
  action: MailAction;
  summary: string;
  reason: string;
  questions: string[];
  draft: string;
}

export interface MailResult extends Omit<MailAnalysis, 'draft'> {
  id: string;
  subject: string;
  sender: string;
  receivedAt: string;
  draftStatus: 'none' | 'created' | 'stale' | 'uncertain' | 'existing' | 'error';
  messageUrl?: string;
  draftUrl?: string;
  manualPriority?: boolean;
}

export interface StoredMailResult extends MailResult {
  messageId: string;
  conversationId: string;
  sourceHash: string;
  categoryApplied: boolean;
  draftId?: string;
  operationPending?: boolean;
}

export interface MailCheckpoint {
  url?: string;
  pending: string[];
  nextUrl?: string;
  hasMore?: boolean;
}

export interface MailHistoryCheckpoint extends MailCheckpoint {
  from?: string;
  until: string;
  processed: number;
  completed: boolean;
  nextFirst?: 'live' | 'history';
}

export interface MailJob {
  ownerId: string;
  settings: MailSettings;
  revision: number;
  enabledAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  leaseToken?: string;
  leaseUntil?: Date;
  checkpoint?: MailCheckpoint;
  history?: MailHistoryCheckpoint;
}

export interface MailStore {
  read(ownerId: string): Promise<MailJob | null>;
  saveSettings(ownerId: string, settings: MailSettings, now: Date): Promise<void>;
  pause(ownerId: string): Promise<void>;
  purge(ownerId: string): Promise<void>;
  due(now: Date): Promise<string[]>;
  prune(now: Date): Promise<void>;
  claim(ownerId: string, token: string, now: Date): Promise<MailJob | null>;
  update(ownerId: string, token: string, fields: Partial<MailJob>): Promise<boolean>;
  release(ownerId: string, token: string, fields: Partial<MailJob>): Promise<void>;
  results(ownerId: string): Promise<StoredMailResult[]>;
  result(ownerId: string, id: string): Promise<StoredMailResult | null>;
  putResult(ownerId: string, token: string, result: StoredMailResult): Promise<void>;
  draftState(
    ownerId: string,
    conversationKey: string,
  ): Promise<{ sourceHash: string; state: 'pending' | 'completed' | 'failed' } | null>;
  reserveDraft(
    ownerId: string,
    token: string,
    conversationKey: string,
    sourceHash: string,
  ): Promise<boolean>;
  finishDraft(
    ownerId: string,
    conversationKey: string,
    sourceHash: string,
    state: 'completed' | 'failed',
  ): Promise<void>;
}

export interface MailGraph {
  identity(): Promise<{ id: string; mail: string; userPrincipalName: string }>;
  page(
    since: string,
    url?: string,
  ): Promise<{ messages: MailMessage[]; nextUrl?: string; hasMore: boolean }>;
  historyPage(
    from: string | undefined,
    until: string,
    url?: string,
  ): Promise<{ messages: MailMessage[]; nextUrl?: string; hasMore: boolean }>;
  message(id: string): Promise<MailMessage>;
  thread(id: string): Promise<{ messages: MailMessage[]; complete: boolean }>;
  categorize(id: string, categories: string[], etag?: string): Promise<void>;
  createReply(id: string, text: string): Promise<{ id: string; url?: string }>;
}

export interface MailRuntimeAdapter {
  authorize(ownerId: string): Promise<void>;
  availability(ownerId: string): Promise<{
    available: boolean;
    reason?: string;
    modelLabel: string;
    modelFingerprint?: string;
  }>;
  connection(ownerId: string): Promise<{ connected: boolean; mailbox?: string }>;
  graph(ownerId: string, beforeRequest: () => Promise<void>): Promise<MailGraph>;
  analyze(
    ownerId: string,
    messages: MailMessage[],
    beforeRequest: () => Promise<void>,
  ): Promise<MailAnalysis>;
  audit(ownerId: string, event: string, resultId?: string): Promise<void>;
}

export interface MailAssistantStatus {
  available: boolean;
  reason?: string;
  modelLabel: string;
  modelFingerprint?: string;
  connection: { connected: boolean; mailbox?: string };
  settings: MailSettings;
  activity: {
    running: boolean;
    lastRunAt?: string;
    nextRunAt?: string;
    lastError?: string;
    pending: number;
    hasMore: boolean;
    history: {
      mode: 'off' | 'since' | 'all';
      processed: number;
      pending: number;
      hasMore: boolean;
      completed: boolean;
      from?: string;
      until?: string;
    };
  };
  results: MailResult[];
}

export interface MailAssistantEngine {
  status(owner: string): Promise<MailAssistantStatus>;
  settings(owner: string, input: unknown): Promise<void>;
  run(owner: string, scheduled?: boolean): Promise<void>;
  pause(owner: string): Promise<void>;
  disconnect(owner: string): Promise<void>;
  priority(owner: string, id: string, priority: MailPriority): Promise<void>;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}
