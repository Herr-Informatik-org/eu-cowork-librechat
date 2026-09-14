import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TSubmission } from 'librechat-data-provider';
import type { CompletionResult } from '~/utils/notifications';
import { notifyCompletion } from '~/utils/notifications';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';

export default function useCompletionNotification() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const navigate = useNavigate();
  return useCallback(
    (result: CompletionResult, submission: TSubmission) => {
      void notifyCompletion({
        userId: user?.id,
        result,
        submission,
        title: localize('com_ui_notification_complete_title'),
        body: localize('com_ui_notification_complete_body'),
        openConversation: (id) => navigate(`/c/${encodeURIComponent(id)}`),
      });
    },
    [user?.id, localize, navigate],
  );
}
