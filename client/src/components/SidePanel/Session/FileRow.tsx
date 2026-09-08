import { useState } from 'react';
import { FileText, FileSpreadsheet, Presentation, Image } from 'lucide-react';
import type { TFile } from 'librechat-data-provider';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import OfficeFilePreviewButton, { createOfficeFileArtifact } from './OfficeFilePreviewButton';
import SessionFileDownloadButton from './SessionFileDownloadButton';

function fileIcon(extension: string) {
  if (/^(xlsx?|ods|csv)$/.test(extension)) return FileSpreadsheet;
  if (extension === 'pptx') return Presentation;
  if (/^(png|jpe?g|gif|webp)$/.test(extension)) return Image;
  return FileText;
}

export default function FileRow({
  file,
  artifactId,
}: {
  file: Partial<TFile>;
  artifactId?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = file.filename || file.file_id || '';
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const Icon = fileIcon(extension);
  const content = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate" title={name}>
        {name}
      </span>
    </>
  );
  const officePreview = artifactId || createOfficeFileArtifact(file);
  return (
    <div className="session-file-row">
      {officePreview ? (
        <OfficeFilePreviewButton
          file={file}
          artifactId={artifactId}
          label={name}
          className="session-file-open session-focus"
        >
          {content}
        </OfficeFilePreviewButton>
      ) : (
        <button
          type="button"
          className="session-file-open session-focus"
          disabled={!file.file_id}
          onClick={() => setOpen(true)}
        >
          {content}
        </button>
      )}
      <SessionFileDownloadButton file={file} />
      {open && (
        <FilePreviewDialog
          open={open}
          onOpenChange={setOpen}
          fileName={name}
          fileId={file.file_id}
          filePath={file.filepath}
          fileType={file.type}
          fileSize={file.bytes}
        />
      )}
    </div>
  );
}
