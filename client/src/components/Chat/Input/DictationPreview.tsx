import { useLocalize } from '~/hooks';
import type { DictationStatus } from './AudioRecorder';

export default function DictationPreview({
  status,
  existingText,
}: {
  status: DictationStatus;
  existingText: string;
}) {
  const localize = useLocalize();
  return (
    <div
      className="max-h-64 min-h-11 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-base leading-6"
      role="status"
      aria-live="polite"
      data-testid="dictation-preview"
    >
      {existingText && <span className="text-text-primary">{existingText} </span>}
      <span className="italic text-text-secondary">
        {status.text || localize('com_ui_dictation_preview_waiting')}
      </span>
      <span className="mt-1 block text-xs text-text-secondary">
        {localize(
          status.processing
            ? 'com_ui_dictation_finalizing'
            : status.delayed
              ? 'com_ui_dictation_preview_delayed'
              : 'com_ui_dictation_preview_live',
        )}
      </span>
    </div>
  );
}
