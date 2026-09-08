import { memo, useContext, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { FileText, ScrollText, Wrench, X, Globe, Layers } from 'lucide-react';
import { ThemeContext } from '@librechat/client';
import { Constants } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { ThemeSelector } from '~/components/Nav/SettingsTabs/General/Selectors';
import { useChatContext, useFileMapContext } from '~/Providers';
import { useGetMessagesByConvoId } from '~/data-provider';
import { collectSessionContext } from './context';
import { sessionPanelVisible } from './state';
import { useLocalize } from '~/hooks';
import store from '~/store';
import ActivityStatusBadge from '~/components/Chat/Activity/ActivityStatusBadge';
import './session.css';
import OfficeFilePreviewButton, { createOfficeFileArtifact } from './OfficeFilePreviewButton';
import SessionFileDownloadButton, { hasSessionFileDownload } from './SessionFileDownloadButton';

function SessionPanel() {
  const localize = useLocalize();
  const { conversationId } = useParams();
  const { index } = useChatContext();
  const fileMap = useFileMapContext();
  const { theme, setTheme } = useContext(ThemeContext);
  const setVisible = useSetRecoilState(sessionPanelVisible);
  const artifacts = useRecoilValue(store.artifactsState);
  const setArtifact = useSetRecoilState(store.currentArtifactId);
  const showArtifacts = useSetRecoilState(store.artifactsVisibility);
  const [showAllSources, setShowAllSources] = useState(false);
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
  const tools = (data?.tools ?? []).filter((name) => name !== 'skill');
  const sources = data?.sources ?? [];
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
  const rowClass =
    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy';

  return (
    <aside
      className="session-workspace flex h-full flex-col bg-surface-primary text-text-primary"
      aria-label={localize('com_ui_session_workspace')}
    >
      <div className="flex items-start justify-between border-b border-border-light px-5 py-5">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-text-secondary">
            <Layers className="size-4" aria-hidden="true" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">
              {localize('com_ui_session_context')}
            </span>
          </div>
          <h2 className="text-base font-semibold tracking-tight">
            {localize('com_ui_session_workspace')}
          </h2>
          <p className="mt-1 text-xs text-text-secondary">{localize('com_ui_session_scope')}</p>
          <ActivityStatusBadge conversationId={conversationId ?? 'new'} className="mt-3" />
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="session-focus rounded-lg p-2 text-text-secondary hover:bg-surface-hover"
          aria-label={localize('com_ui_close')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {isError && (
          <p role="alert" className="px-2 text-sm text-text-secondary">
            {localize('com_ui_session_load_error')}
          </p>
        )}
        {isLoading && conversationId && conversationId !== Constants.NEW_CONVO && (
          <p role="status" className="px-2 text-sm text-text-secondary">
            {localize('com_ui_loading')}
          </p>
        )}
        <section aria-label={localize('com_ui_session_files')}>
          <h3 className="mb-2 px-2 text-xs font-medium text-text-secondary">
            {localize('com_ui_session_files')} · {files.length}
          </h3>
          {files.length === 0 && (
            <p className="session-empty px-3 py-4 text-xs leading-relaxed text-text-secondary">
              {localize('com_ui_session_files_empty')}
            </p>
          )}
          {files.map((reference) => {
            const file = reference.file_id
              ? (fileMap?.[reference.file_id] ?? reference)
              : reference;
            const id = file.file_id || file.filepath || '';
            const artifactId = file.file_id ? previewByFile.get(file.file_id) : undefined;
            const origin = data?.fileOrigins[reference.file_id || reference.filepath || ''];
            const content = (
              <>
                <span className="session-file-icon">
                  <FileText className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[13px] font-medium"
                    title={file.filename || id}
                  >
                    {file.filename || id}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-text-secondary">
                    {origin?.shared
                      ? localize('com_ui_session_shared_file')
                      : localize('com_ui_session_tool_file')}
                    {origin?.shared && origin.toolOutput
                      ? ` · ${localize('com_ui_session_tool_file')}`
                      : ''}
                  </span>
                </span>
              </>
            );
            return (
              <div key={id} className="session-file-row">
                <div className="flex items-center gap-3">{content}</div>
                <div className="ml-11 mt-2 flex flex-wrap gap-3">
                  <OfficeFilePreviewButton file={file} artifactId={artifactId} />
                  <SessionFileDownloadButton file={file} />
                  {!hasSessionFileDownload(file) &&
                    !artifactId &&
                    !createOfficeFileArtifact(file) && (
                      <span className="text-[11px] text-text-secondary">
                        {localize('com_ui_session_reference_only')}
                      </span>
                    )}
                </div>
              </div>
            );
          })}
          {files.length > 0 && (
            <p className="mt-3 px-2 text-[11px] leading-relaxed text-text-secondary">
              {localize('com_ui_session_file_scope')}
            </p>
          )}
        </section>
        {outputs.length > 0 && (
          <section aria-label={localize('com_ui_session_outputs')}>
            <h3 className="mb-2 px-2 text-xs font-medium text-text-secondary">
              {localize('com_ui_session_outputs')} · {outputs.length}
            </h3>
            {outputs.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className={rowClass}
                onClick={() => {
                  setArtifact(artifact.id);
                  showArtifacts(true);
                }}
              >
                <FileText className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="truncate">
                  {artifact.title || artifact.identifier || artifact.id}
                </span>
              </button>
            ))}
          </section>
        )}
        {sources.length > 0 && (
          <section aria-label={localize('com_ui_session_research')}>
            <h3 className="mb-2 px-2 text-xs font-medium text-text-secondary">
              {localize('com_ui_session_research')} · {sources.length}
            </h3>
            {(showAllSources ? sources : sources.slice(0, 5)).map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="session-source session-focus"
              >
                <Globe
                  className="mt-0.5 size-3.5 shrink-0 text-text-secondary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="line-clamp-2 text-xs font-medium leading-relaxed">
                    {source.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-text-secondary">
                    {new URL(source.url).hostname} ·{' '}
                    {localize(
                      source.processed
                        ? 'com_ui_session_source_read'
                        : 'com_ui_session_source_found',
                    )}
                  </span>
                </span>
              </a>
            ))}
            {sources.length > 5 && (
              <button
                type="button"
                className="session-link session-focus mt-2 px-2"
                onClick={() => setShowAllSources(!showAllSources)}
              >
                {localize(showAllSources ? 'com_ui_session_show_less' : 'com_ui_session_show_all')}
              </button>
            )}
          </section>
        )}
        <details
          key={conversationId ?? Constants.NEW_CONVO}
          open={skills.length + tools.length > 0}
          className="session-details"
          aria-label={localize('com_ui_session_capabilities')}
        >
          <summary className="session-focus text-xs font-medium text-text-secondary">
            {localize('com_ui_session_capabilities')} ·{' '}
            {skills.length + tools.filter((name) => name !== 'skill').length}
          </summary>
          <section className="mt-4" aria-label={localize('com_ui_session_skills')}>
            <h3 className="mb-2 px-2 text-xs font-medium text-text-secondary">
              {localize('com_ui_session_skills')} · {skills.length}
            </h3>
            {skills.length === 0 && (
              <p className="px-2 text-sm text-text-secondary">
                {localize('com_ui_session_skills_empty')}
              </p>
            )}
            {skills.map((name) => (
              <div key={name} className="flex items-center gap-3 px-3 py-2 text-xs">
                <ScrollText className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="truncate">{name}</span>
              </div>
            ))}
          </section>
          <section className="mt-4" aria-label={localize('com_ui_session_tools')}>
            <h3 className="mb-2 px-2 text-xs font-medium text-text-secondary">
              {localize('com_ui_session_tools')} · {tools.length}
            </h3>
            {tools.length === 0 && (
              <p className="px-2 text-sm text-text-secondary">
                {localize('com_ui_session_tools_empty')}
              </p>
            )}
            {tools
              .filter((name) => name !== 'skill')
              .map((name) => (
                <div key={name} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <Wrench className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  <span className="break-all">{name}</span>
                </div>
              ))}
          </section>
        </details>
      </div>
      <div className="border-t border-border-light p-4 text-sm">
        <ThemeSelector theme={theme} onChange={setTheme} popoverClassName="w-[130px]" />
      </div>
    </aside>
  );
}

export default memo(SessionPanel);
