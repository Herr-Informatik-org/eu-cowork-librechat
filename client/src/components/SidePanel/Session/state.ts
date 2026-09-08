import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { atom, useRecoilState } from 'recoil';
import { atomWithLocalStorage } from '~/store/utils';
import store from '~/store';

export const sessionContextHidden = atomWithLocalStorage('sessionContextHidden', false);
export const sessionClosing = atom<'hide' | 'close' | null>({
  key: 'sessionClosing',
  default: null,
});

/** Keep the selected document mounted until its exit transition has finished. */
export function useSessionExit() {
  const { conversationId } = useParams();
  const [closing, setClosing] = useRecoilState(sessionClosing);
  const [, setHidden] = useRecoilState(sessionContextHidden);
  const [, setVisible] = useRecoilState(store.artifactsVisibility);
  const [, setArtifactId] = useRecoilState(store.currentArtifactId);
  useEffect(() => {
    setClosing(null);
  }, [conversationId, setClosing]);
  useEffect(() => {
    if (!closing) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(
      () => {
        setVisible(false);
        if (closing === 'close') setArtifactId(null);
        else setHidden(true);
        setClosing(null);
      },
      reduced ? 150 : 240,
    );
    return () => window.clearTimeout(timer);
  }, [closing, setClosing, setHidden, setVisible, setArtifactId]);
}

export function useSessionVisibility() {
  const [hidden, setHidden] = useRecoilState(sessionContextHidden);
  const [artifactVisible, setArtifactVisible] = useRecoilState(store.artifactsVisibility);
  const [artifactId] = useRecoilState(store.currentArtifactId);
  const [closing, setClosing] = useRecoilState(sessionClosing);
  const contextVisible = closing !== 'hide' && (!hidden || (!!artifactId && artifactVisible));
  const toggleContext = () => {
    if (closing) {
      setClosing(null);
      return;
    }
    if (contextVisible) setClosing('hide');
    else {
      setHidden(false);
      if (artifactId) setArtifactVisible(true);
    }
  };
  return { contextVisible, toggleContext };
}
