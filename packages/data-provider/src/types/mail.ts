export type MailWorkspacePriority = 'important' | 'normal' | 'low';
export type MailWorkspaceSettings = {
  enabled: boolean;
  mode: 'manual' | 'scheduled';
  weekdays: number[];
  startTime: string;
  endTime: string;
  timeZone: string;
  intervalMinutes: 15 | 30 | 60;
  consentVersion?: string;
  history?: { mode: 'off' | 'since' | 'all'; from?: string };
};
export type MailWorkspaceResult = {
  id: string;
  revision: string;
  subject: string;
  sender: string;
  receivedAt: string;
  priority: MailWorkspacePriority;
  action: 'reply' | 'review' | 'information';
  summary: string;
  reason: string;
  questions: string[];
  draftStatus: 'none' | 'created' | 'stale' | 'uncertain' | 'existing' | 'error';
  moveStatus?: 'completed' | 'uncertain';
  doneFolder?: string;
  draftWarnings?: string[];
};
export type MailWorkspaceStatus = {
  available: boolean;
  reason?: string;
  modelLabel: string;
  modelFingerprint?: string;
  connection: { connected: boolean; mailbox?: string };
  settings: MailWorkspaceSettings;
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
  results: MailWorkspaceResult[];
};
export type MailWorkspacePreview = {
  html: string;
  blockedImages: number;
  truncated: boolean;
  warnings: string[];
};
export type MailWorkspaceContent = {
  resultId: string;
  mailbox: string;
  message: {
    subject: string;
    sender: string;
    receivedAt: string;
    body: string;
    bodyTruncated: boolean;
    preview?: MailWorkspacePreview;
  };
  draft?: {
    subject: string;
    url?: string;
    body: string;
    bodyTruncated: boolean;
    preview?: MailWorkspacePreview;
    revision?: string;
    replyText?: string;
  };
  draftUnavailable?: boolean;
};
export type MailWorkspaceFolder = {
  id: string;
  displayName: string;
  path?: string;
  childFolderCount?: number;
  canMoveTo: boolean;
  parentFolderId?: string;
};
export type MailWorkspaceParams = {
  cursor?: string;
  search?: string;
  priority?: MailWorkspacePriority;
  state?: 'open' | 'done' | 'all';
};
export type MailWorkspacePage = { results: MailWorkspaceResult[]; nextCursor?: string };

export type MailWorkspaceMoveRequest = {
  requestId: string;
  folderId: string;
  items: { id: string; revision: string }[];
};
export type MailWorkspaceMoveJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  folderName: string;
  total: number;
  completed: number;
  failed: number;
  items: {
    id: string;
    subject: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
    error?: string;
  }[];
  createdAt: string;
  updatedAt: string;
};

export type MailFollowupProfile = 'odoo-administrator' | 'odoo-admin' | 'odoo-technik';
export type MailFollowupTarget = {
  profile: MailFollowupProfile;
  mode: 'project' | 'todo';
  projectId?: number;
};
export type MailFollowupSettings = MailFollowupTarget & {
  projectName?: string;
  userName: string;
};
export type MailFollowupConfiguration = {
  profiles: { id: MailFollowupProfile; label: string }[];
  settings: MailFollowupSettings | null;
};
export type MailFollowupOutcome = {
  taskId?: number;
  taskUrl?: string;
  action?: 'created' | 'appended';
  status: 'completed' | 'uncertain';
};
export type MailFollowupPreview =
  | {
      token: string;
      title: string;
      body: string;
      targetLabel: string;
      writeAvailable: boolean;
      writeReason?: string;
      candidates: { id: number; name: string; customer?: string }[];
      suggestedTaskId?: number;
      expiresAt: string;
      existing?: never;
    }
  | { existing: MailFollowupOutcome };
export type MailDraftRequest = {
  revision: string;
  instructions: string;
  requestId: string;
};
export type MailDraftOutcome = {
  status: 'created' | 'existing' | 'uncertain';
  draftUrl?: string;
};
export type MailAttachments = {
  attachments: {
    id: string;
    name: string;
    contentType: string;
    size: number;
    isInline: boolean;
  }[];
  hasMore: boolean;
};
