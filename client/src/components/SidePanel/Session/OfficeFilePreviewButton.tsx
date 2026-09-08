import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import type { TFile } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** Register only a reference. The private PDF route reads the authorized original lazily. */
export function createOfficeFileArtifact(file: Partial<TFile>): Artifact | null {
  const extension = /\.(docx|pptx|xlsx|xls|ods)$/i.exec(file.filename ?? '')?.[1].toLowerCase();
  if (!file.file_id || !extension) {
    return null;
  }
  let type: string = TOOL_ARTIFACT_TYPES.SPREADSHEET;
  if (extension === 'docx') {
    type = TOOL_ARTIFACT_TYPES.DOCX;
  } else if (extension === 'pptx') {
    type = TOOL_ARTIFACT_TYPES.PRESENTATION;
  }
  return {
    id: `office-file-${file.file_id}`,
    lastUpdateTime: Date.now(),
    title: file.filename,
    identifier: file.filename,
    type,
    content: '<meta name="librechat-office-source" content="original">',
    download: {
      file_id: file.file_id,
      filepath: file.filepath,
      source: file.source,
      user: file.user,
    },
  };
}

export default function OfficeFilePreviewButton({
  file,
  artifactId,
  children,
  className = 'session-link session-focus',
  label,
}: {
  file: Partial<TFile>;
  artifactId?: string;
  children?: ReactNode;
  className?: string;
  label?: string;
}) {
  const localize = useLocalize();
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setArtifact = useSetRecoilState(store.currentArtifactId);
  const showArtifacts = useSetRecoilState(store.artifactsVisibility);
  const lazyArtifact = artifactId ? null : createOfficeFileArtifact(file);
  if (!artifactId && !lazyArtifact) {
    return null;
  }
  return (
    <button
      type="button"
      className={className}
      aria-label={label ?? localize('com_ui_session_preview')}
      onClick={() => {
        if (lazyArtifact) {
          setArtifacts((previous) => ({
            ...previous,
            [lazyArtifact.id]: lazyArtifact,
          }));
        }
        setArtifact(artifactId ?? lazyArtifact!.id);
        showArtifacts(true);
      }}
    >
      {children ?? (
        <>
          <Eye className="size-3" aria-hidden="true" />
          {localize('com_ui_session_preview')}
        </>
      )}
    </button>
  );
}
