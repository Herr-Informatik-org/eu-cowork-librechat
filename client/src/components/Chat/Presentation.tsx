import { useEffect, useMemo } from 'react';
import { useRecoilValue, useRecoilState, useSetRecoilState } from 'recoil';
import { FileSources, LocalStorageKeys } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import useResetArtifactsOnConversationChange from '~/hooks/Artifacts/useResetArtifactsOnConversationChange';
import DragDropWrapper from '~/components/Chat/Input/Files/DragDropWrapper';
import { EditorProvider, ArtifactsProvider } from '~/Providers';
import { useDeleteFilesMutation } from '~/data-provider';
import Artifacts from '~/components/Artifacts/Artifacts';
import { SidePanelGroup } from '~/components/SidePanel';
import { useSetFilesToDelete, useLocalize } from '~/hooks';
import store from '~/store';
import SessionPanel from '~/components/SidePanel/Session/Panel';
import { sessionPanelVisible } from '~/components/SidePanel/Session/state';

export default function Presentation({ children }: { children: React.ReactNode }) {
  const localize = useLocalize();
  const [sessionVisible, setSessionVisible] = useRecoilState(sessionPanelVisible);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const artifacts = useRecoilValue(store.artifactsState);
  const artifactsVisibility = useRecoilValue(store.artifactsVisibility);
  // Render-gating the panel on `currentArtifactId != null` (in addition
  // to visibility + non-empty artifacts) means the side panel only opens
  // when *something* is actively focused. Conversation navigation
  // resets `currentArtifactId` to null, so the panel stays closed when
  // a user revisits an old conversation full of artifacts. New artifacts
  // arriving via SSE auto-focus through `ToolArtifactCard`'s mount effect
  // (gated on `isSubmitting`), restoring the legacy streaming UX.
  const currentArtifactId = useRecoilValue(store.currentArtifactId);

  useResetArtifactsOnConversationChange();

  const setFilesToDelete = useSetFilesToDelete();

  const { mutateAsync } = useDeleteFilesMutation({
    onSuccess: () => {
      console.log('Temporary Files deleted');
      setFilesToDelete({});
    },
    onError: (error) => {
      console.log('Error deleting temporary files:', error);
    },
  });

  useEffect(() => {
    const filesToDelete = localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE);
    const map = JSON.parse(filesToDelete ?? '{}') as Record<string, ExtendedFile>;
    const files = Object.values(map)
      .filter(
        (file) =>
          file.filepath != null && file.source && !(file.embedded ?? false) && file.temp_file_id,
      )
      .map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath as string,
        source: file.source as FileSources,
        embedded: !!(file.embedded ?? false),
      }));

    if (files.length === 0) {
      return;
    }
    mutateAsync({ files });
  }, [mutateAsync]);

  const artifactsElement = useMemo(() => {
    if (
      artifactsVisibility === true &&
      currentArtifactId != null &&
      Object.keys(artifacts ?? {}).length > 0
    ) {
      return (
        <ArtifactsProvider>
          <EditorProvider>
            <Artifacts />
          </EditorProvider>
        </ArtifactsProvider>
      );
    }
    return null;
  }, [artifactsVisibility, artifacts, currentArtifactId]);
  const sessionElement = sessionVisible ? <SessionPanel /> : null;

  return (
    <DragDropWrapper className="relative flex w-full grow overflow-hidden bg-presentation">
      <SidePanelGroup
        panelDefaultSize={artifactsElement ? '50' : '30'}
        artifacts={
          artifactsElement ? (
            <div className="flex h-full flex-col">
              <div className="border-b border-border-light bg-surface-primary px-4 py-2">
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
                  onClick={() => {
                    setCurrentArtifactId(null);
                    setSessionVisible(true);
                  }}
                >
                  {localize('com_ui_session_back')}
                </button>
              </div>
              <div className="min-h-0 flex-1">{artifactsElement}</div>
            </div>
          ) : (
            sessionElement
          )
        }
      >
        <main className="session-chat-host flex h-full flex-col overflow-y-auto" role="main">
          {children}
        </main>
      </SidePanelGroup>
    </DragDropWrapper>
  );
}
