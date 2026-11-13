import type { DictationStatus } from './AudioRecorder';

export default function DictationPreview({
  status,
  existingText,
}: {
  status: DictationStatus;
  existingText: string;
}) {
  return (
    <div
      className="max-h-64 min-h-11 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-base leading-6"
      role="status"
      aria-live="polite"
      data-testid="dictation-preview"
    >
      {existingText && <span className="text-text-primary">{existingText} </span>}
      <span className="italic text-text-secondary">{status.text}</span>
    </div>
  );
}
