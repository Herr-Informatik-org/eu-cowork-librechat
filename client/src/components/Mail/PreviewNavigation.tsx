import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { mailPreviewLink } from 'librechat-data-provider';
import type { MailPreviewLink } from 'librechat-data-provider';
import type { RefObject } from 'react';
import { useLocalize } from '~/hooks';

/** The CSP hash must match this fixed bridge exactly; mail content never enters its source. */
export const MAIL_PREVIEW_BRIDGE_SCRIPT = `(()=>{const token=document.documentElement.getAttribute('data-mail-preview-token');function select(event){const anchor=event.target instanceof Element?event.target.closest('a'):null;if(!anchor)return;event.preventDefault();if(!event.isTrusted||(event.type==='auxclick'&&event.button!==1))return;const value=anchor.getAttribute('data-mail-link-index');if(!value||!/^(0|[1-9][0-9]*)$/.test(value))return;const index=Number(value);if(!Number.isSafeInteger(index))return;parent.postMessage({type:'mail-preview-link',token,index},'*');}document.addEventListener('click',select);document.addEventListener('auxclick',select);})();`;

export const MAIL_PREVIEW_BRIDGE_HASH = 'sha256-y6ryl5QdnW3a56AJRZ3pK3goAEfsyQjixWwCMiPkg8Q=';

const controlClass =
  'mail-button focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#237e75]';

interface PreviewNavigationOptions {
  frameRef: RefObject<HTMLIFrameElement | null>;
  documentToken?: string;
  links: readonly MailPreviewLink[];
  enabled: boolean;
  trustedOrigins?: readonly string[];
}

interface SelectedLink {
  token: string;
  index: number;
  href: string;
}

export interface MailPreviewNavigation {
  link?: MailPreviewLink;
  close: () => void;
}

function resolveLink(
  options: PreviewNavigationOptions,
  index: number,
): MailPreviewLink | undefined {
  if (!options.enabled || !options.documentToken || !Number.isSafeInteger(index) || index < 0)
    return;
  const candidate = options.links[index];
  return candidate && mailPreviewLink(candidate.href, options.trustedOrigins);
}

/** An opaque frame may request a current link index, but cannot supply a navigation target. */
export function useMailPreviewNavigation(options: PreviewNavigationOptions): MailPreviewNavigation {
  const [selected, setSelected] = useState<SelectedLink | null>(null);
  const current = useRef(options);
  useLayoutEffect(() => {
    current.current = options;
  });
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const active = current.current;
      const source = active.frameRef.current?.contentWindow;
      if (
        !source ||
        event.source !== source ||
        event.origin !== 'null' ||
        !event.data ||
        typeof event.data !== 'object' ||
        Array.isArray(event.data)
      )
        return;
      const data = event.data as Partial<{ type: string; token: string; index: number }>;
      if (
        Object.keys(data).length !== 3 ||
        data.type !== 'mail-preview-link' ||
        data.token !== active.documentToken ||
        typeof data.token !== 'string' ||
        typeof data.index !== 'number'
      )
        return;
      const link = resolveLink(active, data.index);
      if (link) setSelected({ token: data.token, index: data.index, href: link.href });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const close = useCallback(() => setSelected(null), []);
  const candidate =
    selected && selected.token === options.documentToken
      ? resolveLink(options, selected.index)
      : undefined;
  const link = candidate?.href === selected?.href ? candidate : undefined;
  useLayoutEffect(() => {
    if (selected && !link) setSelected(null);
  }, [selected, link]);
  return { link, close };
}

function LinkDialog({ link, close }: { link: MailPreviewLink; close: () => void }) {
  const t = useLocalize();
  const previousFocus = useRef(document.activeElement);
  const mounted = useRef(true);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link.href);
      if (mounted.current) setCopyStatus('copied');
    } catch {
      if (mounted.current) setCopyStatus('failed');
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[150] bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[160] grid max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border-light bg-background p-5 text-text-primary shadow-xl [--mail-accent:#237e75]"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previous = previousFocus.current;
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
          }}
        >
          <Dialog.Title className="text-lg font-semibold">
            {t('com_ui_mail_link_title')}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-text-secondary">
            {t('com_ui_mail_link_external')}
          </Dialog.Description>
          <dl className="min-w-0 text-sm">
            <dt className="font-medium">{t('com_ui_mail_link_destination')}</dt>
            <dd className="mt-1 break-all">
              <strong dir="ltr">{new URL(link.destination).hostname}</strong>
              <p className="mt-1 whitespace-pre-wrap" dir="ltr">
                {link.destination}
              </p>
            </dd>
          </dl>
          {link.viaSafeLinks && (
            <p className="text-sm text-text-secondary">{t('com_ui_mail_link_safelinks')}</p>
          )}
          {link.viaOdooRedirect && (
            <p className="text-sm text-text-secondary">{t('com_ui_mail_link_odoo')}</p>
          )}
          <label className="grid min-w-0 gap-1 text-sm">
            <span>{t('com_ui_mail_link_original')}</span>
            <textarea
              readOnly
              value={link.href}
              dir="ltr"
              rows={3}
              className="w-full resize-y rounded border border-border-light bg-background p-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#237e75]"
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <a
              className={`${controlClass} primary`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {t('com_ui_mail_link_open')}
            </a>
            <button className={controlClass} type="button" onClick={copyLink}>
              {t('com_ui_mail_link_copy')}
            </button>
            <Dialog.Close className={controlClass} type="button">
              {t('com_ui_mail_close')}
            </Dialog.Close>
          </div>
          <p role="status" className="min-h-5 text-sm text-text-secondary">
            {copyStatus === 'copied' && t('com_ui_mail_copied')}
            {copyStatus === 'failed' && t('com_ui_mail_link_copy_failed')}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MailPreviewLinkDialog({ navigation }: { navigation: MailPreviewNavigation }) {
  return navigation.link ? (
    <LinkDialog key={navigation.link.href} link={navigation.link} close={navigation.close} />
  ) : null;
}
