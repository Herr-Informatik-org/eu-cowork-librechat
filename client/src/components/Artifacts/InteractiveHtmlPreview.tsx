import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocalize } from '~/hooks';
import { interactiveHtmlDocument, artifactDeepLink } from '~/utils/interactiveHtml';
import type { Artifact } from '~/common';

export default function InteractiveHtmlPreview({
  artifact,
  content,
}: {
  artifact: Artifact;
  content: string;
}) {
  const localize = useLocalize();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const location = useLocation();
  const preview = useMemo(() => {
    try {
      return { html: interactiveHtmlDocument(content), error: false };
    } catch {
      return { html: '', error: true };
    }
  }, [content]);
  if (preview.error)
    return (
      <p role="alert" className="p-4">
        {localize('com_ui_artifact_too_large')}
      </p>
    );
  const href = artifactDeepLink(window.location.href, artifact.id);
  return (
    <div className="flex h-full flex-col bg-white text-black">
      <div className="flex flex-wrap items-center gap-3 border-b p-2 text-sm">
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
          {localize('com_ui_artifact_open_tab')}
        </a>
        <button
          type="button"
          className="underline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(href);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopyError(true);
            }
          }}
        >
          {copied ? localize('com_ui_artifact_link_copied') : localize('com_ui_artifact_copy_link')}
        </button>
        <span className="text-xs text-gray-600">
          {location.pathname.startsWith('/share/')
            ? localize('com_ui_artifact_shared_access')
            : localize('com_ui_artifact_private_access')}
        </span>
      </div>
      {copyError && (
        <input
          aria-label={localize('com_ui_artifact_manual_link')}
          readOnly
          value={href}
          onFocus={(event) => event.target.select()}
          className="m-2 border p-2 text-sm"
        />
      )}
      <iframe
        title={artifact.title || localize('com_ui_artifact_interactive_preview')}
        className="min-h-0 w-full flex-1 border-0"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={preview.html}
      />
    </div>
  );
}
