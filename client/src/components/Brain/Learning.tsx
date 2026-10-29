import { useParams } from 'react-router-dom';
import { useLocalize } from '~/hooks';
import { useBrainLearningQuery } from '~/data-provider/Brain';

/** Separate actual learning completion from the count of previously stored memories. */
export default function Learning() {
  const localize = useLocalize();
  const { conversationId } = useParams();
  const { data, isError } = useBrainLearningQuery(conversationId);
  if (!data && !isError) return null;
  const keys = {
    idle: 'com_ui_brain_learning_idle',
    running: 'com_ui_brain_learning_running',
    completed: data?.saved ? 'com_ui_brain_learning_saved' : 'com_ui_brain_learning_unchanged',
    failed: 'com_ui_brain_learning_failed',
    interrupted: 'com_ui_brain_learning_interrupted',
    disabled: 'com_ui_brain_paused_description',
    skipped: 'com_ui_brain_learning_skipped',
  } as const;
  return (
    <div className="brain-panel-note" role="status">
      <strong>{localize('com_ui_brain_learning_title')}</strong>
      <p>
        {localize(isError ? 'com_ui_brain_learning_unavailable' : keys[data!.status], {
          count: data?.saved ?? 0,
        })}
      </p>
      {data?.updatedAt && (
        <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time>
      )}
      {data?.status === 'failed' && data.errorCode && (
        <p>
          {data.errorCode}
          {data.incidentId ? ` · ${data.incidentId}` : ''}
        </p>
      )}
    </div>
  );
}
