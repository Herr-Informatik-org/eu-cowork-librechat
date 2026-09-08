import { useRecoilState } from 'recoil';
import { atomWithLocalStorage } from '~/store/utils';
import store from '~/store';

export const sessionContextHidden = atomWithLocalStorage('sessionContextHidden', false);

export function useSessionVisibility() {
  const [hidden, setHidden] = useRecoilState(sessionContextHidden);
  const [artifactVisible, setArtifactVisible] = useRecoilState(store.artifactsVisibility);
  const [artifactId] = useRecoilState(store.currentArtifactId);
  const contextVisible = !hidden || (!!artifactId && artifactVisible);
  const toggleContext = () => {
    if (contextVisible) {
      setHidden(true);
      setArtifactVisible(false);
    } else {
      setHidden(false);
      if (artifactId) setArtifactVisible(true);
    }
  };
  return { contextVisible, toggleContext };
}
