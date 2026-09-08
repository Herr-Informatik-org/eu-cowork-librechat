import { Download } from 'lucide-react';
import type { TFile } from 'librechat-data-provider';
import {
  isLocallyStoredSource,
  useAttachmentLink,
} from '~/components/Chat/Messages/Content/Parts/LogLink';
import { useLocalize } from '~/hooks';
import { safeSessionFileUrl } from './context';

export function hasSessionFileDownload(file: Partial<TFile>): boolean {
  return (
    !!safeSessionFileUrl(file.filepath) ||
    (!!file.file_id && !!file.user && isLocallyStoredSource(file.source))
  );
}

export default function SessionFileDownloadButton({ file }: { file: Partial<TFile> }) {
  const localize = useLocalize();
  const { handleDownload } = useAttachmentLink({
    href: safeSessionFileUrl(file.filepath) ?? '',
    filename: file.filename || file.file_id || localize('com_ui_session_original'),
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });
  if (!hasSessionFileDownload(file)) return null;
  return (
    <button
      type="button"
      className="session-icon-button session-focus"
      onClick={handleDownload}
      aria-label={`${localize('com_ui_session_original')}: ${file.filename || file.file_id || ''}`}
      title={localize('com_ui_session_original')}
    >
      <Download className="size-4" aria-hidden="true" />
    </button>
  );
}
