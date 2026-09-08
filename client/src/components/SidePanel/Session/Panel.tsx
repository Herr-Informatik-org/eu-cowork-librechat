import { memo, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { FileText, ScrollText, X } from 'lucide-react';
import { Constants } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { useChatContext, useFileMapContext } from '~/Providers';
import { useGetMessagesByConvoId } from '~/data-provider';
import { collectSessionContext } from './context';
import { sessionContextHidden } from './state';
import { useLocalize } from '~/hooks';
import FileRow from './FileRow';
import store from '~/store';
import './session.css';

function SessionPanel({ variant = 'panel' }: { variant?: 'panel' | 'widget' }) {
  const localize = useLocalize();
  const { conversationId } = useParams();
  const { index } = useChatContext();
  const fileMap = useFileMapContext();
  const setVisible = useSetRecoilState(sessionContextHidden);
  const artifacts = useRecoilValue(store.artifactsState);
  const setArtifact = useSetRecoilState(store.currentArtifactId);
  const showArtifacts = useSetRecoilState(store.artifactsVisibility);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const { data, isError, isLoading } = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled:
        !!conversationId &&
        conversationId !== Constants.SEARCH &&
        conversationId !== Constants.NEW_CONVO,
      select: collectSessionContext,
    },
    { isStreaming: isSubmitting },
  );
  const files = data?.files ?? [];
  const skills = data?.skills ?? [];
  const { previewByFile, outputs } = useMemo(() => {
    const ids = new Set(data?.files.map((file) => file.file_id).filter(Boolean));
    const artifactIds = new Set([...ids].map((id) => `tool-artifact-${id}`));
    const messageIds = new Set(data?.messageIds);
    const current = Object.values(artifacts ?? {}).filter(
      (artifact): artifact is Artifact =>
        artifact != null &&
        ((artifact.messageId && messageIds.has(artifact.messageId)) ||
          (artifact.download?.file_id && ids.has(artifact.download.file_id)) ||
          artifactIds.has(artifact.id)),
    );
    const previewByFile = new Map<string, string>();
    for (const artifact of current) {
      const id = artifact.download?.file_id || artifact.id.replace(/^tool-artifact-/, '');
      previewByFile.set(id, artifact.id);
    }
    return {
      previewByFile,
      outputs: current.filter(
        (artifact) =>
          !ids.has(artifact.download?.file_id || artifact.id.replace(/^tool-artifact-/, '')),
      ),
    };
  }, [data, artifacts]);

  return (
    <aside
      className={`session-workspace session-${variant}`}
      aria-label={localize('com_ui_session_workspace')}
      data-testid={`session-${variant}`}
    >
      {variant === 'panel' && (
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="session-close session-icon-button session-focus"
          aria-label={localize('com_ui_close')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
      {isError && (
        <p role="alert" className="session-empty">
          {localize('com_ui_session_load_error')}
        </p>
      )}
      {isLoading && conversationId && conversationId !== Constants.NEW_CONVO && (
        <p role="status" className="session-empty">
          {localize('com_ui_loading')}
        </p>
      )}
      <section aria-label={localize('com_ui_session_files')} className="session-section">
        <h3 className="session-section-title">
          {localize('com_ui_session_files')}
          <span className="session-count">{files.length + outputs.length}</span>
        </h3>
        {!isLoading && files.length + outputs.length === 0 && (
          <p className="session-empty">{localize('com_ui_session_files_empty')}</p>
        )}
        {files.map((reference) => {
          const file = reference.file_id
            ? { ...reference, ...fileMap?.[reference.file_id] }
            : reference;
          const id = file.file_id || file.filepath || '';
          return (
            <FileRow
              key={id}
              file={file}
              artifactId={file.file_id ? previewByFile.get(file.file_id) : undefined}
            />
          );
        })}
        {outputs.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            className="session-file-open session-focus"
            onClick={() => {
              setArtifact(artifact.id);
              showArtifacts(true);
            }}
          >
            <FileText className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{artifact.title || artifact.identifier || artifact.id}</span>
          </button>
        ))}
      </section>
      {skills.length > 0 && (
        <section aria-label={localize('com_ui_session_skills')} className="session-section">
          <h3 className="session-section-title">{localize('com_ui_session_skills')}</h3>
          {skills.map((name) => (
            <div key={name} className="session-skill">
              <ScrollText className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{name}</span>
            </div>
          ))}
        </section>
      )}
    </aside>
  );
}

export default memo(SessionPanel);
