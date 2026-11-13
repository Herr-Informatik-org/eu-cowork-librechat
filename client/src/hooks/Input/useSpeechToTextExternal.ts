import { useCallback, useEffect, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { useSpeechToTextMutation } from '~/data-provider';
import useGetAudioSettings from './useGetAudioSettings';
import { useLocalize } from '~/hooks';
import store from '~/store';

const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_RECORDING_BYTES = 24 * 1024 * 1024;
const AUTO_TRANSCRIBE_SILENCE_MS = 15000;

type RecordingSession = {
  scope: string;
  chunks: Blob[];
  bytes: number;
  cancelled: boolean;
  stopping: boolean;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  context?: AudioContext;
  frame?: number;
  timer?: ReturnType<typeof setTimeout>;
};

let recordingOwner: RecordingSession | null = null;

function releaseOwner(session: RecordingSession) {
  if (recordingOwner === session) recordingOwner = null;
}

function releaseMicrophone(session: RecordingSession) {
  if (session.timer !== undefined) clearTimeout(session.timer);
  if (session.frame !== undefined) cancelAnimationFrame(session.frame);
  session.context?.close().catch(() => undefined);
  session.context = undefined;
  session.stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
  session.stream = undefined;
}

function getMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
}

const useSpeechToTextExternal = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => boolean | void,
  onRecordingStart?: () => void,
) => {
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const { speechToTextEndpoint } = useGetAudioSettings();
  const location = useLocation();
  const currentScope = `${speechToTextEndpoint}:${location.key}`;
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const sessionRef = useRef<RecordingSession | null>(null);
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef({ setText, onTranscriptionComplete, onRecordingStart });
  callbacksRef.current = { setText, onTranscriptionComplete, onRecordingStart };
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const minDecibels = useRecoilValue(store.decibelValue);
  const autoSendText = useRecoilValue(store.autoSendText);
  const languageSTT = useRecoilValue<string>(store.languageSTT);
  const appLanguage = useRecoilValue<string>(store.lang);
  const speechToText = useRecoilValue<boolean>(store.speechToText);
  const autoTranscribeAudio = useRecoilValue<boolean>(store.autoTranscribeAudio);
  const autoSendRef = useRef({ autoSendText, speechToText });
  autoSendRef.current = { autoSendText, speechToText };
  const { mutateAsync: processAudio } = useSpeechToTextMutation();

  const clearAutoSend = useCallback(() => {
    if (autoSendTimerRef.current !== null) clearTimeout(autoSendTimerRef.current);
    autoSendTimerRef.current = null;
  }, []);

  const cancelRecording = useCallback(() => {
    clearAutoSend();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    session.cancelled = true;
    releaseOwner(session);
    session.chunks = [];
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    releaseMicrophone(session);
  }, [clearAutoSend]);

  useEffect(() => {
    setIsListening(false);
    setIsLoading(false);
    const onPageHide = () => {
      cancelRecording();
      setIsListening(false);
      setIsLoading(false);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      cancelRecording();
    };
  }, [cancelRecording, currentScope]);

  useEffect(() => clearAutoSend, [autoSendText, clearAutoSend, speechToText]);

  const externalStopRecording = useCallback(() => {
    clearAutoSend();
    const session = sessionRef.current;
    if (!session || session.stopping || session.cancelled) return;
    session.stopping = true;
    setIsListening(false);
    if (session.recorder && session.recorder.state !== 'inactive') {
      setIsLoading(true);
      session.recorder.stop();
    } else {
      session.cancelled = true;
      releaseOwner(session);
      sessionRef.current = null;
      setIsLoading(false);
    }
    releaseMicrophone(session);
  }, [clearAutoSend]);

  const externalStartRecording = useCallback(async () => {
    if (speechToTextEndpoint !== 'external' || sessionRef.current || recordingOwner) return;
    clearAutoSend();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast({ message: localize('com_ui_speech_not_supported'), status: 'error' });
      return;
    }
    const session: RecordingSession = {
      scope: scopeRef.current,
      chunks: [],
      bytes: 0,
      cancelled: false,
      stopping: false,
    };
    sessionRef.current = session;
    recordingOwner = session;
    setIsLoading(true);
    const isCurrent = () =>
      !session.cancelled && sessionRef.current === session && session.scope === scopeRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      session.stream = stream;
      if (!isCurrent() || session.stopping) {
        releaseMicrophone(session);
        return;
      }
      const mimeType = getMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      session.recorder = recorder;
      const selectedLanguage =
        languageSTT.trim() ||
        (appLanguage === 'auto' ? navigator.language : appLanguage) ||
        navigator.language;
      recorder.ondataavailable = ({ data }) => {
        if (!isCurrent() || !data.size) return;
        session.chunks.push(data);
        session.bytes += data.size;
        if (session.bytes >= MAX_RECORDING_BYTES && !session.stopping) {
          showToast({
            message: localize('com_ui_dictation_limit'),
            status: 'warning',
          });
          externalStopRecording();
        }
      };
      recorder.onstop = async () => {
        releaseMicrophone(session);
        if (!isCurrent()) return;
        setIsListening(false);
        setIsLoading(true);
        const type = recorder.mimeType || mimeType || session.chunks[0]?.type || 'audio/webm';
        const audio = new Blob(session.chunks, { type });
        session.chunks = [];
        try {
          if (!audio.size) {
            showToast({
              message: localize('com_ui_dictation_empty'),
              status: 'warning',
            });
            return;
          }
          let extension = 'webm';
          if (type.includes('mp4')) extension = 'm4a';
          else if (type.includes('ogg')) extension = 'ogg';
          const formData = new FormData();
          formData.append('audio', audio, `audio.${extension}`);
          if (selectedLanguage) formData.append('language', selectedLanguage);
          const data = await processAudio(formData);
          if (!isCurrent()) return;
          const text = data.text?.trim() || '';
          if (!text) {
            showToast({
              message: localize('com_ui_dictation_empty'),
              status: 'warning',
            });
            return;
          }
          callbacksRef.current.setText(text);
          const { autoSendText: delay, speechToText: enabled } = autoSendRef.current;
          if (enabled && Number.isFinite(delay) && delay >= 0) {
            autoSendTimerRef.current = setTimeout(() => {
              autoSendTimerRef.current = null;
              if (session.scope === scopeRef.current && !session.cancelled) {
                callbacksRef.current.onTranscriptionComplete(text);
              }
            }, delay * 1000);
          }
        } catch {
          if (isCurrent()) {
            showToast({
              message: localize('com_ui_dictation_failed'),
              status: 'error',
            });
          }
        } finally {
          if (isCurrent()) {
            sessionRef.current = null;
            releaseOwner(session);
            setIsLoading(false);
          }
        }
      };
      recorder.onerror = () => {
        if (!isCurrent()) return;
        cancelRecording();
        setIsListening(false);
        setIsLoading(false);
        showToast({
          message: localize('com_ui_dictation_interrupted'),
          status: 'error',
        });
      };
      stream.getAudioTracks().forEach((track) => {
        track.onended = externalStopRecording;
      });
      callbacksRef.current.onRecordingStart?.();
      recorder.start(250);
      setIsLoading(false);
      setIsListening(true);
      session.timer = setTimeout(() => {
        if (!isCurrent()) return;
        showToast({
          message: localize('com_ui_dictation_duration_limit'),
          status: 'warning',
        });
        externalStopRecording();
      }, MAX_RECORDING_MS);

      if (autoTranscribeAudio && speechToText) {
        try {
          const context = new AudioContext();
          session.context = context;
          const analyser = context.createAnalyser();
          analyser.minDecibels = minDecibels;
          context.createMediaStreamSource(stream).connect(analyser);
          const samples = new Uint8Array(analyser.frequencyBinCount);
          let lastSound = Date.now();
          const detectSound = () => {
            if (!isCurrent() || session.stopping) return;
            analyser.getByteFrequencyData(samples);
            if (samples.some((value) => value > 0)) lastSound = Date.now();
            if (Date.now() - lastSound > AUTO_TRANSCRIBE_SILENCE_MS) {
              externalStopRecording();
              return;
            }
            session.frame = requestAnimationFrame(detectSound);
          };
          session.frame = requestAnimationFrame(detectSound);
        } catch {
          session.context?.close().catch(() => undefined);
          session.context = undefined;
          showToast({
            message: localize('com_ui_dictation_manual_stop'),
            status: 'warning',
          });
        }
      }
    } catch {
      releaseMicrophone(session);
      if (isCurrent()) {
        sessionRef.current = null;
        releaseOwner(session);
        setIsLoading(false);
        setIsListening(false);
        showToast({
          message: localize('com_ui_microphone_unavailable'),
          status: 'error',
        });
      }
    }
  }, [
    appLanguage,
    autoTranscribeAudio,
    cancelRecording,
    clearAutoSend,
    externalStopRecording,
    languageSTT,
    localize,
    minDecibels,
    processAudio,
    showToast,
    speechToText,
    speechToTextEndpoint,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        !event.shiftKey ||
        !event.altKey ||
        event.code !== 'KeyL' ||
        speechToTextEndpoint !== 'external'
      )
        return;
      event.preventDefault();
      if (sessionRef.current) externalStopRecording();
      else void externalStartRecording();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [externalStartRecording, externalStopRecording, speechToTextEndpoint]);

  return { isListening, isLoading, externalStartRecording, externalStopRecording };
};

export default useSpeechToTextExternal;
