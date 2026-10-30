import { useSyncExternalStore } from 'react';
import type { Agents } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import ToolApproval from '~/components/Chat/Messages/Content/ToolApproval';
import { getLocalFolderAction, retryLocalFolderAction } from './bridge';
import { getLocalFolderRevision, subscribeLocalFolders } from './store';

export default function LocalFolderActionStatus(props: {
  approval: NonNullable<Agents.ToolCall['approval']>;
  toolCallId: string;
  args: string | Record<string, unknown> | undefined;
}) {
  useSyncExternalStore(subscribeLocalFolders, getLocalFolderRevision, getLocalFolderRevision);
  const localize = useLocalize();
  const status = getLocalFolderAction(props.approval.actionId);
  const messages = {
    mixed: 'com_ui_local_folders_mixed',
    retry: 'com_ui_local_folders_ack_failed',
    sent: 'com_ui_local_folders_done',
    reading: 'com_ui_local_folders_pending',
    unavailable: 'com_ui_local_folders_missing',
    cancelled: 'com_ui_local_folders_stopped',
  } as const;
  const message = status ? messages[status] : 'com_ui_local_folders_missing';
  return (
    <div className="my-2 rounded-lg border border-border-light p-3 text-sm">
      <p role="status">{localize(message)}</p>
      {status === 'retry' && (
        <button
          type="button"
          className="mt-2 rounded border px-3 py-1 focus-visible:ring-2"
          onClick={() => retryLocalFolderAction(props.approval.actionId)}
        >
          {localize('com_ui_local_folders_retry')}
        </button>
      )}
      {(status === 'mixed' || !status) && (
        <ToolApproval {...props} approval={{ ...props.approval, allowed_decisions: ['reject'] }} />
      )}
    </div>
  );
}
