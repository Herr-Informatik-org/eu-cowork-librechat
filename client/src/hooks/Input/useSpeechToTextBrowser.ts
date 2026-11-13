import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import SpeechRecognitionImport, { useSpeechRecognition } from 'react-speech-recognition';
import useGetAudioSettings from './useGetAudioSettings';
import { useLocalize } from '~/hooks';
import store from '~/store';

type SpeechRecognitionController = Pick<
  typeof SpeechRecognitionImport,
  'startListening' | 'stopListening' | 'abortListening' | 'getRecognition' | 'getRecognitionManager'
>;
type SpeechRecognitionModule = Partial<SpeechRecognitionController> & {
  default?: Partial<SpeechRecognitionController>;
};

const hasSpeechRecognitionController = (
  controller?: Partial<SpeechRecognitionController>,
): controller is SpeechRecognitionController =>
  typeof controller?.startListening === 'function' &&
  typeof controller.stopListening === 'function' &&
  typeof controller.abortListening === 'function' &&
  typeof controller.getRecognition === 'function' &&
  typeof controller.getRecognitionManager === 'function';

const speechRecognitionModule = SpeechRecognitionImport as SpeechRecognitionModule;
const SpeechRecognition = hasSpeechRecognitionController(speechRecognitionModule)
  ? speechRecognitionModule
  : speechRecognitionModule.default;

let recordingOwner: symbol | null = null;
let transcriptOwner: symbol | null = null;

const useSpeechToTextBrowser = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => boolean | void,
  onRecordingStart?: () => void,
) => {
  const localize = useLocalize();
  const location = useLocation();
  const { showToast } = useToastContext();
  const { speechToTextEndpoint } = useGetAudioSettings();
  const isBrowserSTTEnabled = speechToTextEndpoint === 'browser';
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);
  const autoSendText = useRecoilValue(store.autoSendText);
  const languageSTT = useRecoilValue<string>(store.languageSTT);
  const appLanguage = useRecoilValue<string>(store.lang);

  const [isListening, setIsListening] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const ownerRef = useRef(Symbol('browser-dictation'));
  const currentScope = `${speechToTextEndpoint}:${location.key}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const sessionScopeRef = useRef(currentScope);
  const sessionRef = useRef(0);
  const requestedRef = useRef(false);
  const acceptingResultsRef = useRef(false);
  const lastTranscriptRef = useRef('');
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const pendingStopRef = useRef<Promise<void> | null>(null);
  const pendingAbortRef = useRef<Promise<void> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ setText, onTranscriptionComplete, onRecordingStart });
  callbacksRef.current = { setText, onTranscriptionComplete, onRecordingStart };

  const {
    transcript,
    finalTranscript,
    interimTranscript,
    resetTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition({ transcribing: isBrowserSTTEnabled });

  const clearAutoSend = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    clearAutoSend();
    sessionRef.current += 1;
    requestedRef.current = false;
    acceptingResultsRef.current = false;
    if (transcriptOwner === ownerRef.current) {
      transcriptOwner = null;
    }
    setIsListening(false);
    setIsStopping(false);
    if (
      recordingOwner !== ownerRef.current ||
      pendingAbortRef.current ||
      !hasSpeechRecognitionController(SpeechRecognition)
    ) {
      return;
    }
    const recognition = SpeechRecognition.getRecognition();
    if (recognition) {
      recognition.continuous = false;
    }
    const abort = async () => {
      await (pendingStopRef.current ?? pendingStartRef.current)?.catch(() => undefined);
      if (SpeechRecognition.getRecognitionManager().listening) {
        await SpeechRecognition.abortListening();
      }
    };
    pendingAbortRef.current = abort()
      .catch(() => undefined)
      .finally(() => {
        pendingAbortRef.current = null;
        if (recordingOwner === ownerRef.current) {
          recordingOwner = null;
        }
      });
  }, [clearAutoSend]);

  useEffect(() => {
    if (
      !isBrowserSTTEnabled ||
      sessionScopeRef.current !== currentScope ||
      !acceptingResultsRef.current ||
      transcriptOwner !== ownerRef.current ||
      !transcript ||
      transcript === lastTranscriptRef.current
    ) {
      return;
    }
    callbacksRef.current.setText(transcript);
    lastTranscriptRef.current = transcript;
  }, [currentScope, isBrowserSTTEnabled, transcript]);

  useEffect(() => {
    clearAutoSend();
    if (
      !isBrowserSTTEnabled ||
      sessionScopeRef.current !== currentScope ||
      !requestedRef.current ||
      recordingOwner !== ownerRef.current ||
      autoSendText < 0 ||
      !Number.isFinite(autoSendText) ||
      !finalTranscript ||
      interimTranscript
    ) {
      return;
    }
    const session = sessionRef.current;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      if (
        !requestedRef.current ||
        session !== sessionRef.current ||
        sessionScopeRef.current !== scopeRef.current
      ) {
        return;
      }
      const submitted = callbacksRef.current.onTranscriptionComplete(finalTranscript);
      if (submitted === false) {
        return;
      }
      lastTranscriptRef.current = '';
      resetTranscript();
    }, autoSendText * 1000);
    return clearAutoSend;
  }, [
    autoSendText,
    clearAutoSend,
    currentScope,
    finalTranscript,
    interimTranscript,
    isBrowserSTTEnabled,
    resetTranscript,
  ]);

  const startRecording = useCallback(async () => {
    if (
      !isBrowserSTTEnabled ||
      requestedRef.current ||
      pendingStartRef.current ||
      pendingStopRef.current ||
      pendingAbortRef.current ||
      (recordingOwner !== null && recordingOwner !== ownerRef.current)
    ) {
      return;
    }
    if (!browserSupportsSpeechRecognition || !hasSpeechRecognitionController(SpeechRecognition)) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }
    if (!isMicrophoneAvailable) {
      showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
      return;
    }

    clearAutoSend();
    callbacksRef.current.onRecordingStart?.();
    resetTranscript();
    lastTranscriptRef.current = '';
    const session = ++sessionRef.current;
    sessionScopeRef.current = scopeRef.current;
    requestedRef.current = true;
    acceptingResultsRef.current = true;
    recordingOwner = ownerRef.current;
    transcriptOwner = ownerRef.current;
    setIsListening(true);
    const fallbackLanguage =
      (appLanguage === 'auto' ? navigator.language : appLanguage) || navigator.language || 'en-US';
    const language = languageSTT.trim() || (fallbackLanguage === 'de' ? 'de-DE' : fallbackLanguage);
    const start = SpeechRecognition.startListening({ language, continuous: true });
    pendingStartRef.current = start;
    try {
      await start;
      if (session !== sessionRef.current) {
        cancelRecording();
        return;
      }
      if (!SpeechRecognition.getRecognitionManager().listening) {
        cancelRecording();
      }
    } catch {
      if (session === sessionRef.current) {
        cancelRecording();
        showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
      }
    } finally {
      pendingStartRef.current = null;
    }
  }, [
    appLanguage,
    browserSupportsSpeechRecognition,
    cancelRecording,
    clearAutoSend,
    isBrowserSTTEnabled,
    isMicrophoneAvailable,
    languageSTT,
    localize,
    resetTranscript,
    showToast,
    sttExternal,
  ]);

  const stopRecording = useCallback((): Promise<void> => {
    clearAutoSend();
    if (pendingStopRef.current) {
      return pendingStopRef.current;
    }
    if (!requestedRef.current || !hasSpeechRecognitionController(SpeechRecognition)) {
      return Promise.resolve();
    }
    requestedRef.current = false;
    setIsStopping(true);
    const session = sessionRef.current;
    const stop = async () => {
      await pendingStartRef.current;
      if (session !== sessionRef.current) {
        return;
      }
      const recognition = SpeechRecognition.getRecognition();
      if (recognition) {
        recognition.continuous = false;
      }
      if (SpeechRecognition.getRecognitionManager().listening) {
        await SpeechRecognition.stopListening();
      }
    };
    const operation = stop()
      .catch(() => {
        if (session === sessionRef.current) {
          cancelRecording();
          showToast({ message: localize('com_ui_microphone_unavailable'), status: 'error' });
        }
      })
      .finally(() => {
        pendingStopRef.current = null;
        if (session === sessionRef.current) {
          setIsListening(false);
          setIsStopping(false);
          if (recordingOwner === ownerRef.current && !pendingAbortRef.current) {
            recordingOwner = null;
          }
        }
      });
    pendingStopRef.current = operation;
    return operation;
  }, [cancelRecording, clearAutoSend, localize, showToast]);

  useEffect(() => {
    if (!isMicrophoneAvailable) {
      cancelRecording();
    }
  }, [cancelRecording, isMicrophoneAvailable]);

  useEffect(() => {
    window.addEventListener('pagehide', cancelRecording);
    return () => {
      window.removeEventListener('pagehide', cancelRecording);
      cancelRecording();
    };
  }, [cancelRecording, isBrowserSTTEnabled, location.key]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !isBrowserSTTEnabled ||
        event.repeat ||
        !event.shiftKey ||
        !event.altKey ||
        event.code !== 'KeyL'
      ) {
        return;
      }
      event.preventDefault();
      if (requestedRef.current) {
        void stopRecording();
      } else {
        void startRecording();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBrowserSTTEnabled, startRecording, stopRecording]);

  return { isListening, isLoading: isStopping, startRecording, stopRecording };
};

export default useSpeechToTextBrowser;
