import React, { useLayoutEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { FileSources, apiBaseUrl } from 'librechat-data-provider';
import { useCodeOutputDownload, useFileDownload, useSharedFileDownload } from '~/data-provider';
import { authenticatedCodeDownloadPath, triggerDownload } from '~/utils';
import { useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface LogLinkProps {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
  children: React.ReactNode;
}

interface AttachmentLinkOptions {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
  scopeKey?: string;
}

/**
 * Determines if a file is stored locally (not an external API URL).
 * Files with these sources are stored on the LibreChat server and should
 * use the /api/files/download endpoint instead of direct URL access.
 */
export const isLocallyStoredSource = (source?: string): boolean => {
  if (!source) {
    return false;
  }
  return [
    FileSources.local,
    FileSources.firebase,
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
  ].includes(source as FileSources);
};

export const useAttachmentLink = ({
  href,
  filename,
  file_id,
  user,
  source,
  scopeKey,
}: AttachmentLinkOptions) => {
  const { showToast } = useToastContext();
  const { shareId } = useShareContext();
  const localize = useLocalize();
  const currentUser = useRecoilValue(store.user);

  const downloadUser = user || currentUser?.id;
  const useStoredDownload =
    source !== FileSources.execute_code && !!file_id && !!downloadUser && !!currentUser?.id;
  const codePath = authenticatedCodeDownloadPath(href, apiBaseUrl());
  const useSharedDownload = !!shareId && !!file_id && href.startsWith('/api/share/');
  const { refetch: downloadFromApi } = useFileDownload(downloadUser, file_id, {
    source,
    direct: false,
  });
  const { refetch: downloadFromShare } = useSharedFileDownload(shareId, file_id);
  const { refetch: downloadFromUrl } = useCodeOutputDownload(codePath);
  const scope = `${currentUser?.id ?? ''}:${shareId ?? ''}:${downloadUser ?? ''}:${file_id ?? ''}:${source ?? ''}:${href}:${scopeKey ?? ''}`;
  const currentScope = useRef(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = '';
    };
  }, [scope]);
  const reportError = () => {
    showToast({ status: 'error', message: localize('com_ui_download_error') });
    return false;
  };

  /**
   * Triggers the download and reports whether a file was actually
   * delivered: `true` once a download is initiated, `false` on a fetch
   * error or an empty/denied response (e.g. an expired code-output URL or
   * a 404 share download). Callers that show success feedback should gate
   * it on this result rather than on the promise merely resolving.
   */
  const handleDownload = async (
    event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
  ): Promise<boolean> => {
    event.preventDefault();
    try {
      if (!useSharedDownload && !useStoredDownload && !(codePath && currentUser?.id))
        return reportError();
      const downloadPrivate = useStoredDownload ? downloadFromApi : downloadFromUrl;
      const download = useSharedDownload ? downloadFromShare : downloadPrivate;
      const stream = await download();
      if (currentScope.current !== scope) {
        if (stream.data?.startsWith('blob:')) URL.revokeObjectURL(stream.data);
        return false;
      }
      if (stream.isError || !stream.data?.startsWith('blob:')) return reportError();
      triggerDownload(stream.data, filename);
      return true;
    } catch {
      return currentScope.current === scope ? reportError() : false;
    }
  };

  return { handleDownload, downloadHref: codePath || '#' };
};

const LogLink: React.FC<LogLinkProps> = ({ href, filename, file_id, user, source, children }) => {
  const { handleDownload, downloadHref } = useAttachmentLink({
    href,
    filename,
    file_id,
    user,
    source,
  });
  return (
    <a
      href={downloadHref}
      onClick={handleDownload}
      rel="noopener noreferrer"
      className="!text-blue-400 visited:!text-purple-400 hover:underline"
    >
      {children}
    </a>
  );
};

export default LogLink;
