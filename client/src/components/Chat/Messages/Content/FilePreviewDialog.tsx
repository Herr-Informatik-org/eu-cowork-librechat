import { useState, useEffect, useCallback, useMemo } from 'react';
import copy from 'copy-to-clipboard';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Download } from 'lucide-react';
import { OGDialog, OGDialogContent, OGDialogTitle, OGDialogDescription } from '@librechat/client';
import { useFileDownload, useSharedFileDownload } from '~/data-provider';
import { logger, sortPagesByRelevance, triggerDownload } from '~/utils';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';
import ImageFilePreview, { getImagePreviewMime } from './ImageFilePreview';
import { createOfficeFileArtifact } from '~/components/SidePanel/Session/OfficeFilePreviewButton';

interface FilePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  fileId?: string;
  filePath?: string;
  relevance?: number;
  pages?: number[];
  pageRelevance?: Record<number, number>;
  fileType?: string;
  fileSize?: number;
}

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function canPreviewByMime(mime?: string): 'pdf' | 'text' | false {
  if (!mime) {
    return false;
  }
  if (mime.includes('pdf')) {
    return 'pdf';
  }
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('yaml') ||
    mime.includes('csv')
  ) {
    return 'text';
  }
  return false;
}

function canPreviewByExt(filename: string): 'pdf' | 'text' | false {
  const ext = getFileExtension(filename);
  if (ext === 'pdf') {
    return 'pdf';
  }
  const textExts = new Set([
    'txt',
    'md',
    'csv',
    'json',
    'xml',
    'yaml',
    'yml',
    'html',
    'css',
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'rb',
    'java',
    'c',
    'cpp',
    'h',
    'go',
    'rs',
    'sh',
    'sql',
    'log',
  ]);
  return textExts.has(ext) ? 'text' : false;
}

/** Formats bytes with unit suffix (differs from ~/utils/formatBytes which returns a raw number). */
function formatBytes(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function getDisplayType(fileType?: string, fileName?: string): string {
  if (fileType) {
    if (fileType.includes('pdf')) {
      return 'PDF';
    }
    if (fileType.includes('word') || fileType.includes('document')) {
      return 'Document';
    }
    if (fileType.includes('spreadsheet') || fileType.includes('excel')) {
      return 'Spreadsheet';
    }
    if (fileType.includes('presentation') || fileType.includes('powerpoint')) {
      return 'Presentation';
    }
    if (fileType.includes('image')) {
      return 'Image';
    }
    if (fileType.startsWith('text/')) {
      return fileType.split('/')[1]?.toUpperCase() || 'Text';
    }
    if (fileType.includes('json')) {
      return 'JSON';
    }
    if (fileType.includes('xml')) {
      return 'XML';
    }
  }
  const ext = fileName ? getFileExtension(fileName) : '';
  return ext ? ext.toUpperCase() : 'File';
}

export default function FilePreviewDialog({
  open,
  onOpenChange,
  fileName,
  fileId,
  filePath,
  relevance,
  pages,
  pageRelevance,
  fileType,
  fileSize,
}: FilePreviewDialogProps) {
  const localize = useLocalize();
  const user = useRecoilValue(store.user);
  const { shareId } = useShareContext();
  const { refetch: downloadOwned } = useFileDownload(user?.id ?? '', fileId, {
    direct: false,
  });
  const { refetch: downloadShared } = useSharedFileDownload(shareId, fileId);
  // Use the share route only for snapshotted files (filepath rewritten to the
  // share path); otherwise fall back to the owner route.
  const useShared = !!shareId && (filePath?.startsWith('/api/share/') ?? false);
  const downloadFile = useShared ? downloadShared : downloadOwned;

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifact = useSetRecoilState(store.currentArtifactId);
  const showArtifacts = useSetRecoilState(store.artifactsVisibility);
  const officeArtifact = useMemo(
    () =>
      !shareId
        ? createOfficeFileArtifact({
            file_id: fileId,
            filename: fileName,
            filepath: filePath,
          })
        : null,
    [shareId, fileId, fileName, filePath],
  );
  useEffect(() => {
    if (!open || !officeArtifact) return;
    setArtifacts((previous) => ({
      ...previous,
      [officeArtifact.id]: officeArtifact,
    }));
    setCurrentArtifact(officeArtifact.id);
    showArtifacts(true);
    onOpenChange(false);
  }, [open, officeArtifact, setArtifacts, setCurrentArtifact, showArtifacts, onOpenChange]);
  const imageMime = getImagePreviewMime(fileName, fileType);
  const filePreviewKind = imageMime
    ? 'image'
    : canPreviewByMime(fileType) || canPreviewByExt(fileName);
  const previewKind = officeArtifact ? false : filePreviewKind;

  useEffect(() => {
    setFileContent(null);
    setFileBlobUrl(null);
    setPreviewError(false);
    setLoading(false);
    setIsCopied(false);
    if (!open || !fileId || !previewKind) return;

    let cancelled = false;
    let previewUrl: string | undefined;
    const controller = new AbortController();
    setLoading(true);

    async function loadPreview() {
      try {
        const result = await downloadFile();
        if (cancelled) return;
        if (result.isError || !result.data) throw new Error('File download unavailable');
        const response = await fetch(result.data, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('File download failed');
        const blob = await response.blob();
        if (cancelled) return;

        if (previewKind === 'text') {
          const content = await blob.text();
          if (!cancelled) setFileContent(content);
          return;
        }
        const typed = new Blob([blob], {
          type: previewKind === 'image' ? imageMime : 'application/pdf',
        });
        previewUrl = URL.createObjectURL(typed);
        setFileBlobUrl(previewUrl);
      } catch {
        if (!cancelled) setPreviewError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadPreview();
    return () => {
      cancelled = true;
      controller.abort();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [open, fileId, fileName, previewKind, imageMime, downloadFile]);

  const handleDownload = useCallback(async () => {
    if (!fileId) {
      return;
    }
    try {
      const result = await downloadFile();
      if (!result.data) {
        return;
      }
      triggerDownload(result.data, fileName);
    } catch (err) {
      logger.error('[FilePreviewDialog] Download failed:', err);
    }
  }, [downloadFile, fileId, fileName]);

  const handleCopy = useCallback(() => {
    if (!fileContent) {
      return;
    }
    copy(fileContent, { format: 'text/plain' });
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 3000);
  }, [fileContent]);

  const displayType = useMemo(() => getDisplayType(fileType, fileName), [fileType, fileName]);
  const sortedPages = useMemo(
    () => (pages && pageRelevance ? sortPagesByRelevance(pages, pageRelevance) : pages),
    [pages, pageRelevance],
  );

  const metaParts: string[] = previewKind === 'image' ? [] : [displayType];
  if (relevance != null && relevance > 0) {
    metaParts.push(`${localize('com_ui_relevance')}: ${Math.round(relevance * 100)}%`);
  }
  if (fileSize != null && fileSize > 0) {
    metaParts.push(formatBytes(fileSize));
  }
  if (sortedPages && sortedPages.length > 0) {
    metaParts.push(localize('com_file_pages', { pages: sortedPages.join(', ') }));
  }

  if (officeArtifact) return null;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="flex w-full max-w-4xl flex-col !overflow-hidden p-0"
        showCloseButton={true}
      >
        <div className="shrink-0 px-6 pr-12 pt-6">
          <OGDialogTitle className="truncate text-base">{fileName}</OGDialogTitle>
          <div className="mt-0.5 flex items-center gap-3">
            <OGDialogDescription className="min-w-0 truncate">
              {metaParts.join(' · ')}
            </OGDialogDescription>
            {fileId && (
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex shrink-0 items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                aria-label={`${localize('com_ui_download')} ${fileName}`}
              >
                <Download className="size-3" aria-hidden="true" />
                {localize('com_ui_download')}
              </button>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
          {loading && (
            <div className="flex h-60 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="shimmer text-sm text-text-secondary">
                {localize('com_ui_loading')}
              </span>
            </div>
          )}
          {previewError && (
            <div className="flex h-32 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
            </div>
          )}
          {fileBlobUrl && previewKind === 'image' && (
            <ImageFilePreview key={fileBlobUrl} src={fileBlobUrl} fileName={fileName} />
          )}
          {fileBlobUrl && previewKind === 'pdf' && (
            <iframe
              src={fileBlobUrl}
              title={`${localize('com_ui_preview')}: ${fileName}`}
              className="h-[70vh] w-full rounded-lg border border-border-light"
            />
          )}
          {fileContent !== null && (
            <>
              <div className="pointer-events-none sticky top-0 z-10 flex justify-end pr-1">
                <CopyButton
                  isCopied={isCopied}
                  onClick={handleCopy}
                  iconOnly
                  label={localize('com_ui_copy')}
                  className="pointer-events-auto rounded-lg bg-surface-secondary"
                />
              </div>
              <div className="-mt-8 rounded-lg bg-surface-secondary p-4">
                <pre className="whitespace-pre-wrap break-words pr-8 font-mono text-sm leading-6 text-text-primary">
                  {fileContent}
                </pre>
              </div>
            </>
          )}
          {!previewKind && !loading && (
            <div className="flex h-32 items-center justify-center rounded-lg bg-surface-secondary">
              <span className="text-sm text-text-secondary">
                {localize('com_ui_preview_unavailable')}
              </span>
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
