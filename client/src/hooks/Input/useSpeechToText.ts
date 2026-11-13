import { useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import useSpeechToTextBrowser from './useSpeechToTextBrowser';
import useSpeechToTextExternal from './useSpeechToTextExternal';
import useGetAudioSettings from './useGetAudioSettings';

const useSpeechToText = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => boolean | void,
  onRecordingStart?: () => void,
): {
  isLoading?: boolean;
  isListening?: boolean;
  stopRecording: () => void | Promise<void>;
  startRecording: () => void | Promise<void>;
  cancelRecording?: () => void;
  previewText?: string;
  previewDelayed?: boolean;
  elapsedSeconds?: number;
  levels?: number[];
  liveDictation?: boolean;
  isFinalizing?: boolean;
} => {
  const { speechToTextEndpoint, isSpeechConfigLoading, retrySpeechConfig } = useGetAudioSettings();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const externalSpeechToText = speechToTextEndpoint === 'external';

  const {
    isListening: speechIsListeningBrowser,
    isLoading: speechIsLoadingBrowser,
    startRecording: startSpeechRecordingBrowser,
    stopRecording: stopSpeechRecordingBrowser,
  } = useSpeechToTextBrowser(setText, onTranscriptionComplete, onRecordingStart);

  const {
    isListening: speechIsListeningExternal,
    isLoading: speechIsLoadingExternal,
    externalStartRecording: startSpeechRecordingExternal,
    externalStopRecording: stopSpeechRecordingExternal,
    cancelRecording,
    previewText,
    previewDelayed,
    elapsedSeconds,
    levels,
    liveDictation,
    isFinalizing,
  } = useSpeechToTextExternal(setText, onTranscriptionComplete, onRecordingStart);

  const isListening = externalSpeechToText ? speechIsListeningExternal : speechIsListeningBrowser;
  const isLoading =
    isSpeechConfigLoading ||
    (externalSpeechToText ? speechIsLoadingExternal : speechIsLoadingBrowser);

  const startRecording = () => {
    if (speechToTextEndpoint === 'unavailable') {
      showToast({ message: localize('com_ui_speech_config_unavailable'), status: 'error' });
      void retrySpeechConfig();
      return;
    }
    if (isSpeechConfigLoading) return;
    return externalSpeechToText ? startSpeechRecordingExternal() : startSpeechRecordingBrowser();
  };
  const stopRecording = externalSpeechToText
    ? stopSpeechRecordingExternal
    : stopSpeechRecordingBrowser;

  return {
    isLoading,
    isListening,
    stopRecording,
    startRecording,
    ...(externalSpeechToText
      ? {
          cancelRecording,
          previewText,
          previewDelayed,
          elapsedSeconds,
          levels,
          liveDictation,
          isFinalizing,
        }
      : {}),
  };
};

export default useSpeechToText;
