import type { MailAttachmentScanResult } from './scanner';

export type MailPriority = 'important' | 'normal' | 'low';
export type MailAction = 'reply' | 'review' | 'information';
/** Last recorded Outlook action, not proof of delivery or a complete send history. */
export type MailResponseAction = 'replied' | 'forwarded';
export type MailFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;
export const MAIL_CONSENT_VERSION = '2026-10-27';
export const MAIL_CATEGORIES: Record<MailPriority, string> = {
  important: 'KI: Wichtig',
  normal: 'KI: Normal',
  low: 'KI: Niedrig',
};

export interface MailSignature {
  enabled: boolean;
  html: string;
  fontFamily: 'Aptos' | 'Calibri' | 'Arial';
  fontSize: 10 | 11 | 12 | 14;
  logo?: { contentBytes: string };
}
export interface MailDraftContext {
  sender: { name: string; address: string };
  recipients: { name: string; address: string }[];
  ccRecipients?: { name: string; address: string }[];
  replyMode?: 'all';
  signatureEnabled: boolean;
}
export interface MailRecipient {
  name: string;
  address: string;
}
export interface MailReplyAllContext {
  selfAddresses: string[];
  to: MailRecipient[];
  cc: MailRecipient[];
}
export interface MailChatRequest {
  revision: string;
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  draft?: string;
  includeCorrespondence?: boolean;
}
export interface MailChatResponse {
  answer: string;
  modelLabel?: string;
  sources?: MailResult[];
}

export interface MailSettings {
  signature?: MailSignature;
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
  senderName?: string;
  replyTo?: { name: string; address: string }[];
  toRecipients?: MailRecipient[];
  ccRecipients?: MailRecipient[];
  isRead?: boolean;
  hasAttachments?: boolean;
  responseAction?: MailResponseAction;
  responseActionAt?: string;
  receivedAt: string;
  sentAt?: string;
  body: string;
  bodyTruncated?: boolean;
  etag?: string;
  categories: string[];
  isDraft: boolean;
  sentByUser?: boolean;
  messageUrl?: string;
  parentFolderId?: string;
}

export interface MailAnalysis {
  priority: MailPriority;
  action: MailAction;
  summary: string;
  reason: string;
  questions: string[];
  draft: string;
  memory?: MailMemoryStatus;
}

export interface MailMemoryStatus {
  status: 'available' | 'empty' | 'disabled' | 'unavailable';
  count: number;
}

export interface MailRuleInput {
  text: string;
  scope: 'sender' | 'global';
  revision: string;
}

export interface MailResult extends Omit<MailAnalysis, 'draft'> {
  mailboxLocation?: 'inbox' | 'sent';
  analysisStatus?: 'pending' | 'complete';
  isRead?: boolean;
  hasAttachments?: boolean;
  responseAction?: MailResponseAction;
  responseActionAt?: string;
  id: string;
  subject: string;
  sender: string;
  receivedAt: string;
  draftStatus: 'none' | 'created' | 'stale' | 'uncertain' | 'existing' | 'error';
  messageUrl?: string;
  draftUrl?: string;
  revision?: string;
  draftWarnings?: string[];
  manualPriority?: boolean;
  moveStatus?: 'completed' | 'uncertain';
  doneFolder?: string;
}

export interface StoredMailResult extends MailResult {
  connectionGeneration?: string;
  correspondent?: string;
  messageId: string;
  conversationId: string;
  sourceHash: string;
  categoryApplied: boolean;
  draftId?: string;
  operationPending?: boolean;
  moveDestination?: string;
  editPending?: boolean;
}

export interface MailResultContent {
  resultId: string;
  mailbox: string;
  message: {
    responseAction?: MailResponseAction;
    responseActionAt?: string;
    replyRecipients?: { name: string; address: string }[];
    replyCcRecipients?: MailRecipient[];
    replyMode?: 'all';
    toRecipients?: { name: string; address: string }[];
    ccRecipients?: { name: string; address: string }[];
    senderName?: string;
    subject: string;
    sender: string;
    receivedAt: string;
    body: string;
    bodyTruncated: boolean;
    preview?: MailHtmlPreview;
  };
  draft?: {
    subject: string;
    body: string;
    bodyTruncated: boolean;
    revision?: string;
    replyText?: string;
    preview?: MailHtmlPreview;
    url?: string;
  };
  draftUnavailable?: boolean;
}

export interface MailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export interface MailAttachments {
  attachments: MailAttachment[];
  hasMore: boolean;
  downloadAvailable?: boolean;
}
export interface MailAttachmentDownload {
  bytes: Buffer;
  name: string;
  contentType: string;
  scan: MailAttachmentScanResult;
}

export interface MailDraftRequest {
  revision: string;
  instructions: string;
  requestId: string;
  newReply?: boolean;
}

export interface MailDraftResponse {
  status: 'created' | 'existing' | 'uncertain';
  draftUrl?: string;
}

export interface MailHtmlPreview {
  embeddedImagesAvailable?: boolean;
  imagesLoaded?: boolean;
  linksEnabled?: boolean;
  trustedOrigins?: string[];
  linkCheck?: {
    status: 'not_listed' | 'known_threat' | 'unavailable' | 'disabled';
    checkedAt?: string;
    sourceUpdatedAt?: string;
    blocked: number;
  };
  html: string;
  blockedImages: number;
  truncated: boolean;
  warnings: string[];
}

export interface MailMoveRequest {
  requestId: string;
  folderId: string;
  items: { id: string; revision: string }[];
}
export interface MailMoveItem {
  id: string;
  subject: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
  error?: string;
}
export interface MailMoveJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  folderName: string;
  total: number;
  completed: number;
  failed: number;
  items: MailMoveItem[];
  createdAt: string;
  updatedAt: string;
}
export interface StoredMailMoveJob extends Omit<MailMoveJob, 'items'> {
  items: (MailMoveItem & { revision: string })[];
  folderId: string;
  connectionGeneration: string;
  mailbox: string;
  settingsRevision: number;
  requestHash: string;
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
  continuation?: { mode: 'manual' | 'scheduled'; revision: number; liveComplete: boolean } | null;
  checkpoint?: MailCheckpoint;
  history?: MailHistoryCheckpoint;
  movePending?: boolean;
}

export interface MailStore {
  read(ownerId: string): Promise<MailJob | null>;
  saveSettings(ownerId: string, settings: MailSettings, now: Date): Promise<void>;
  pause(ownerId: string): Promise<void>;
  purge(ownerId: string): Promise<void>;
  due(now: Date): Promise<string[]>;
  prune(now: Date): Promise<void>;
  moveJobs(ownerId: string): Promise<StoredMailMoveJob[]>;
  enqueueMove(
    ownerId: string,
    job: StoredMailMoveJob,
  ): Promise<'accepted' | 'duplicate' | 'busy' | 'revoked'>;
  updateMove(ownerId: string, token: string, job: StoredMailMoveJob): Promise<boolean>;
  cancelStaleMoves(ownerId: string, now: Date, jobId?: string): Promise<void>;
  movesDue(now: Date): Promise<string[]>;
  claim(
    ownerId: string,
    token: string,
    now: Date,
    manual?: boolean,
    revision?: number,
  ): Promise<MailJob | null>;
  update(ownerId: string, token: string, fields: Partial<MailJob>): Promise<boolean>;
  release(ownerId: string, token: string, fields: Partial<MailJob>): Promise<void>;
  results(ownerId: string): Promise<StoredMailResult[]>;
  result(ownerId: string, id: string): Promise<StoredMailResult | null>;
  putResult(ownerId: string, token: string, result: StoredMailResult): Promise<void>;
  seedResults(ownerId: string, results: StoredMailResult[]): Promise<StoredMailResult[]>;
  draftState(
    ownerId: string,
    conversationKey: string,
  ): Promise<{ sourceHash: string; state: 'pending' | 'completed' | 'failed' } | null>;
  reserveDraft(
    ownerId: string,
    token: string,
    conversationKey: string,
    sourceHash: string,
    retryFailed?: boolean,
  ): Promise<boolean>;
  finishDraft(
    ownerId: string,
    conversationKey: string,
    sourceHash: string,
    state: 'completed' | 'failed',
  ): Promise<void>;
}

export interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  canMoveTo: boolean;
}

export interface MailResultQuery {
  cursor?: string;
  search?: string;
  priority?: MailPriority;
  state?: 'open' | 'done' | 'all';
}
export interface MailResultPage {
  results: MailResult[];
  nextCursor?: string;
  complete?: boolean;
}

export interface MailGraph {
  inboxPage?(
    url?: string,
  ): Promise<{ messages: MailMessage[]; nextUrl?: string; hasMore: boolean }>;
  correspondencePage?(
    partner: string,
    folder: 'inbox' | 'sentitems',
    search?: string,
    url?: string,
  ): Promise<{ messages: MailMessage[]; nextUrl?: string; hasMore: boolean }>;
  identity(): Promise<{
    id: string;
    mail: string;
    userPrincipalName: string;
    displayName?: string;
  }>;
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
  preview(id: string, loadImages?: boolean): Promise<MailHtmlPreview>;
  attachments(id: string): Promise<MailAttachments>;
  downloadAttachment?(id: string, attachmentId: string): Promise<MailAttachmentDownload>;
  thread(id: string): Promise<{ messages: MailMessage[]; complete: boolean }>;
  categorize(id: string, categories: string[], etag?: string): Promise<void>;
  createReply(
    id: string,
    text: string,
    signature?: MailSignature,
    replyAll?: MailReplyAllContext,
  ): Promise<{ id: string; url?: string; warnings?: string[]; stop?: boolean }>;
  folders(parentId?: string): Promise<MailFolder[]>;
  folder(id: string): Promise<MailFolder>;
  move(id: string, folderId: string, etag?: string): Promise<MailMessage>;
  editableReply(id: string): Promise<{ text: string; etag: string }>;
  editDraft(id: string, text: string, etag: string): Promise<void>;
}

export interface MailRuntimeAdapter {
  authorize(ownerId: string): Promise<void>;
  availability(ownerId: string): Promise<{
    available: boolean;
    reason?: string;
    modelLabel: string;
    modelFingerprint?: string;
  }>;
  connection(
    ownerId: string,
  ): Promise<{ connected: boolean; mailbox?: string; generation?: string }>;
  graph(ownerId: string, beforeRequest: () => Promise<void>): Promise<MailGraph>;
  analyze(
    ownerId: string,
    messages: MailMessage[],
    beforeRequest: () => Promise<void>,
  ): Promise<MailAnalysis>;
  analyzeDraft?(
    ownerId: string,
    messages: MailMessage[],
    instructions: string,
    beforeRequest: () => Promise<void>,
    context?: MailDraftContext,
  ): Promise<string>;
  chat?(
    ownerId: string,
    messages: MailMessage[],
    input: MailChatRequest,
    beforeRequest: () => Promise<void>,
  ): Promise<string>;
  audit(ownerId: string, event: string, resultId?: string): Promise<void>;
  rememberRule?(
    ownerId: string,
    input: { text: string; scope: 'sender' | 'global'; sender: string },
  ): Promise<void>;
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
    continuing?: boolean;
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
  content(owner: string, id: string): Promise<MailResultContent>;
  images(
    owner: string,
    id: string,
    kind: 'original' | 'draft',
    revision: string,
  ): Promise<MailHtmlPreview>;
  results(owner: string, query: MailResultQuery): Promise<MailResultPage>;
  folders(owner: string, parentId?: string): Promise<MailFolder[]>;
  move(owner: string, id: string, folderId: string, revision: string): Promise<MailResult>;
  enqueueMove(owner: string, input: MailMoveRequest): Promise<MailMoveJob>;
  moveJobs(owner: string): Promise<MailMoveJob[]>;
  requestDraft(owner: string, id: string, input: MailDraftRequest): Promise<MailDraftResponse>;
  attachments(owner: string, id: string): Promise<MailAttachments>;
  downloadAttachment?(
    owner: string,
    id: string,
    attachmentId: string,
    revision: string,
  ): Promise<MailAttachmentDownload>;
  editDraft(owner: string, id: string, body: string, revision: string): Promise<void>;
  rememberRule(owner: string, id: string, input: MailRuleInput): Promise<void>;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}
