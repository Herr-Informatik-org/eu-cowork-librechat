/** Browser-local capability metadata. File handles and absolute paths never leave the browser. */
export interface LocalFolderGrant {
  id: string;
  label: string;
}

export interface LocalFolderInput {
  folderId: string;
  operation: 'list' | 'search' | 'read' | 'inspect';
  path?: string;
  query?: string;
  cursor?: string;
  /** Direct UTF-8 offset for read/inspect; an existing cursor takes precedence. */
  startByte?: number;
  /** One-based PDF page for read/inspect; an existing cursor takes precedence. */
  page?: number;
}

/** Server-authored budget appended to a validated tool call at the approval boundary. */
export interface LocalFolderRequest extends LocalFolderInput {
  maxChars: number;
}

export interface LocalFolderSource {
  path: string;
  page?: number;
  byteStart?: number;
  byteEnd?: number;
  lineStart?: number;
  lineEnd?: number;
}

export interface LocalFolderResult {
  status: 'ok' | 'partial' | 'unsupported' | 'unavailable' | 'error';
  coverage: {
    complete: boolean;
    filesVisited: number;
    filesRead: number;
    bytesRead: number;
    skipped: number;
    bytesTotal?: number;
    pagesVisited?: number;
    pagesTotal?: number;
    reason?: string;
  };
  nextCursor?: string;
  entries?: Array<{ path: string; kind: 'file' | 'directory'; size?: number }>;
  matches?: Array<LocalFolderSource & { text: string }>;
  text?: string;
  source?: LocalFolderSource;
  message?: string;
}
