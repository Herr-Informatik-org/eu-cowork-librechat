import { useParams } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { sessionContextHidden, sessionClosing } from './state';
import SessionPanel from './Panel';
import store from '~/store';

export default function SessionWidget() {
  const { conversationId } = useParams();
  const closing = useRecoilValue(sessionClosing);
  const panelVisible = useRecoilValue(sessionContextHidden);
  const artifactId = useRecoilValue(store.currentArtifactId);
  const artifactsVisible = useRecoilValue(store.artifactsVisibility);
  if (
    !conversationId ||
    conversationId === Constants.NEW_CONVO ||
    conversationId === Constants.SEARCH ||
    panelVisible ||
    (artifactId && artifactsVisible)
  )
    return null;
  return (
    <div className="session-widget-slot" data-closing={closing === 'hide'}>
      <SessionPanel variant="widget" />
    </div>
  );
}
