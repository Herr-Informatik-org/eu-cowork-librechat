import { memo, useCallback, useEffect, useRef } from 'react';
import { MicOff, Check, X } from 'lucide-react';
import { useToastContext, TooltipAnchor, ListeningIcon, Spinner } from '@librechat/client';
import type { useChatFormContext } from '~/Providers';
import type { TAskFunction } from '~/common';
import { useLocalize, useSpeechToText } from '~/hooks';
import { globalAudioId } from '~/common';
import { cn } from '~/utils';

export type DictationStatus = {
  active: boolean;
  processing: boolean;
  text: string;
  delayed: boolean;
};

export default memo(function AudioRecorder({
  disabled,
  ask,
  methods,
  isSubmitting,
  onDictationStatus,
}: {
  disabled: boolean;
  ask: TAskFunction;
  methods: ReturnType<typeof useChatFormContext>;
  isSubmitting: boolean;
  onDictationStatus?: (status: DictationStatus) => void;
}) {
  const { setValue, reset, getValues } = methods;
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const existingTextRef = useRef<string>('');
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const onTranscriptionComplete = useCallback(
    (text: string) => {
      if (isSubmittingRef.current) {
        showToast({
          message: localize('com_ui_speech_while_submitting'),
          status: 'error',
        });
        return false;
      }
      if (!text) {
        return false;
      }
      const globalAudio = document.getElementById(globalAudioId) as HTMLAudioElement | null;
      if (globalAudio) {
        globalAudio.muted = false;
      }
      const finalText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      const submitted = ask({ text: finalText });
      if (submitted === false) {
        return false;
      }
      reset({ text: '' });
      existingTextRef.current = '';
      return true;
    },
    [ask, reset, showToast, localize],
  );

  const setText = useCallback(
    (text: string) => {
      const newText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      setValue('text', newText, {
        shouldValidate: true,
      });
    },
    [setValue],
  );

  const captureExistingText = useCallback(() => {
    existingTextRef.current = getValues('text') || '';
  }, [getValues]);

  const {
    isListening,
    isLoading,
    startRecording,
    stopRecording,
    cancelRecording,
    previewText = '',
    previewDelayed = false,
    elapsedSeconds = 0,
    levels = [],
    liveDictation = false,
    isFinalizing = false,
  } = useSpeechToText(setText, onTranscriptionComplete, captureExistingText);

  useEffect(() => {
    onDictationStatus?.({
      active: liveDictation && !!isListening,
      processing: liveDictation && !!isFinalizing,
      text: previewText,
      delayed: previewDelayed,
    });
  }, [
    onDictationStatus,
    liveDictation,
    isListening,
    isLoading,
    isFinalizing,
    previewText,
    previewDelayed,
  ]);

  const handleStartRecording = async () => {
    await startRecording();
  };

  const handleStopRecording = async () => {
    await stopRecording();
  };

  const renderIcon = () => {
    if (isListening === true) {
      return <MicOff className="stroke-red-500" />;
    }
    if (isLoading === true) {
      return <Spinner className="stroke-text-secondary" />;
    }
    return <ListeningIcon className="stroke-text-secondary" />;
  };

  if (liveDictation && (isListening || isLoading)) {
    const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;
    return (
      <div className="flex items-center gap-2 text-text-secondary" data-testid="dictation-controls">
        <time
          dateTime={`PT${elapsedSeconds}S`}
          aria-label={localize('com_ui_dictation_elapsed')}
          className="text-xs tabular-nums"
        >
          {elapsed}
        </time>
        <div
          aria-hidden="true"
          className="flex h-6 items-center gap-[2px]"
          data-testid="dictation-waveform"
        >
          {levels.map((level, index) => (
            <span
              key={index}
              className="w-[2px] rounded-full bg-text-secondary transition-[height] duration-100 motion-reduce:transition-none"
              style={{ height: `${2 + Math.round(level * 20)}px` }}
            />
          ))}
        </div>
        {isLoading && <Spinner className="size-4" />}
        <button
          type="button"
          onClick={cancelRecording}
          aria-label={localize('com_ui_dictation_cancel')}
          className="flex size-8 items-center justify-center rounded-lg hover:bg-surface-hover"
        >
          <X className="size-4" />
        </button>
        {isListening && (
          <button
            type="button"
            onClick={handleStopRecording}
            aria-label={localize('com_ui_dictation_finish')}
            className="flex size-8 items-center justify-center rounded-lg bg-surface-secondary text-text-primary hover:bg-surface-hover"
          >
            <Check className="size-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <TooltipAnchor
      description={localize('com_ui_use_micrphone')}
      render={
        <button
          id="audio-recorder"
          type="button"
          aria-label={localize('com_ui_use_micrphone')}
          onClick={isListening === true ? handleStopRecording : handleStartRecording}
          disabled={disabled || isLoading}
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 transition-colors hover:bg-surface-hover',
          )}
          title={localize('com_ui_use_micrphone')}
          aria-pressed={isListening}
        >
          {renderIcon()}
        </button>
      }
    />
  );
});
