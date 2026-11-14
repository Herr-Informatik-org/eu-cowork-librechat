import { useLocalize } from '~/hooks';

export default function ReplySuggestion({
  text,
  descriptionId,
  onAccept,
}: {
  text: string;
  descriptionId: string;
  onAccept: () => void;
}) {
  const localize = useLocalize();
  return (
    <div className="reply-suggestion" data-testid="reply-suggestion">
      <span aria-hidden="true">{text}</span>{' '}
      <button
        type="button"
        className="pointer-events-auto rounded border border-border-medium px-1 text-xs"
        aria-label={localize('com_ui_reply_suggestion_accept')}
        onClick={(event) => {
          event.stopPropagation();
          onAccept();
        }}
      >
        {localize('com_ui_reply_suggestion_tab')}
      </button>
      <span id={descriptionId} className="sr-only">
        {localize('com_ui_reply_suggestion_hint', { 0: text })}
      </span>
    </div>
  );
}
