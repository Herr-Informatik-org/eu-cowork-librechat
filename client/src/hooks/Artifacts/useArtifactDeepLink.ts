import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import store from '~/store';

/** Open an existing authorized artifact after its conversation has hydrated. */
export default function useArtifactDeepLink(): void {
  const location = useLocation();
  const requested = new URLSearchParams(location.hash.slice(1)).get('artifact');
  const artifacts = useRecoilValue(store.artifactsState);
  const select = useSetRecoilState(store.currentArtifactId);
  const show = useSetRecoilState(store.artifactsVisibility);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (requested && requested !== handled.current && artifacts?.[requested]) {
      select(requested);
      show(true);
      handled.current = requested;
    }
  }, [requested, artifacts, select, show]);
}
