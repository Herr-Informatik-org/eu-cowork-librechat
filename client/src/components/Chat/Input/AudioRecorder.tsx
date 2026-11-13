import { memo, useCallback, useRef } from 'react';
import { MicOff } from 'lucide-react';
import { useToastContext, TooltipAnchor, ListeningIcon, Spinner } from '@librechat/client';
import type { useChatFormContext } from '~/Providers';
import type { TAskFunction } from '~/common';
import { useLocalize, useSpeechToText } from '~/hooks';
import { globalAudioId } from '~/common';
import { cn } from '~/utils';

export default memo(function AudioRecorder({
  disabled,
  ask,
  methods,
  isSubmitting,
}: {
  disabled: boolean;
  ask: TAskFunction;
  methods: ReturnType<typeof useChatFormContext>;
  isSubmitting: boolean;
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

  const { isListening, isLoading, startRecording, stopRecording } = useSpeechToText(
    setText,
    onTranscriptionComplete,
    captureExistingText,
  );

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
