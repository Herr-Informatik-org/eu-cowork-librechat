import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import store from '~/store';

const useGetAudioSettings = () => {
  const engineSTT = useRecoilValue<string>(store.engineSTT);
  const engineTTS = useRecoilValue<string>(store.engineTTS);

  const speechToTextEndpoint = ['external', 'openai', 'azureOpenAI'].includes(engineSTT)
    ? 'external'
    : 'browser';
  const textToSpeechEndpoint = engineTTS;

  return useMemo(
    () => ({ speechToTextEndpoint, textToSpeechEndpoint }),
    [speechToTextEndpoint, textToSpeechEndpoint],
  );
};

export default useGetAudioSettings;
