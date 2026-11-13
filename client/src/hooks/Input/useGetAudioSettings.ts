import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import store from '~/store';

const useGetAudioSettings = () => {
  const engineSTT = useRecoilValue<string>(store.engineSTT);
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const { data, isLoading, isError, refetch } = useGetCustomConfigSpeechQuery({ enabled: true });
  let speechToTextEndpoint = ['external', 'openai', 'azureOpenAI'].includes(engineSTT)
    ? 'external'
    : 'browser';
  if (!data && isLoading) speechToTextEndpoint = 'pending';
  else if (!data && isError) speechToTextEndpoint = 'unavailable';
  else if (data?.sttManaged) speechToTextEndpoint = 'external';
  const sttManaged = data?.sttManaged === true;
  const maxRecordingSeconds = sttManaged ? Number(data?.sttMaxRecordingSeconds || 120) : 600;

  return useMemo(
    () => ({
      speechToTextEndpoint,
      textToSpeechEndpoint: engineTTS,
      isSpeechConfigLoading: isLoading && !data,
      retrySpeechConfig: refetch,
      sttManaged,
      maxRecordingSeconds,
    }),
    [speechToTextEndpoint, engineTTS, isLoading, data, refetch, sttManaged, maxRecordingSeconds],
  );
};

export default useGetAudioSettings;
