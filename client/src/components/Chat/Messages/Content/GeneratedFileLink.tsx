import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useMessageContext, useShareContext } from '~/Providers';
import { useAuthContext, useLocalize } from '~/hooks';
import { useAttachmentLink } from './Parts/LogLink';
import { resolveGeneratedFile } from './generatedFileLinks';

export default function GeneratedFileLink({
  'data-sandbox-path': path = '',
  children,
}: {
  'data-sandbox-path'?: string;
  children?: ReactNode;
}) {
  const { downloadAttachments, messageId } = useMessageContext();
  const { shareId } = useShareContext();
  const { user } = useAuthContext();
  const t = useLocalize();
  const file = resolveGeneratedFile(path, downloadAttachments);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const scope = `${user?.id ?? ''}:${shareId ?? ''}:${messageId ?? ''}:${file?.file_id ?? ''}:${path}`;
  const { handleDownload } = useAttachmentLink({
    href: file?.filepath ?? '',
    filename: file?.filename ?? '',
    file_id: file?.file_id,
    source: file?.source,
    user: file?.user,
    scopeKey: `${messageId ?? ''}:${path}`,
  });
  const current = useRef(scope);
  const pending = useRef<string>();
  useLayoutEffect(() => {
    current.current = scope;
    return () => {
      current.current = '';
    };
  }, [scope]);
  useEffect(() => {
    setBusy(false);
    setNotice(false);
  }, [scope]);

  const download = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!file || (!user?.id && !shareId)) {
      setNotice(true);
      return;
    }
    if (pending.current === scope) return;
    pending.current = scope;
    setBusy(true);
    setNotice(false);
    try {
      await handleDownload(event);
    } finally {
      if (pending.current === scope) pending.current = undefined;
      if (current.current === scope) setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="text-left text-blue-600 underline dark:text-blue-400"
        aria-busy={busy}
        aria-disabled={busy}
        onClick={(event) => void download(event)}
      >
        {children}
      </button>
      {notice && (
        <span role="status" className="ml-2 text-sm text-text-secondary">
          {t('com_ui_generated_file_unavailable')}
        </span>
      )}
    </>
  );
}
