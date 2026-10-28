import { Image, Loader2 } from 'lucide-react';
import type { MailWorkspaceImagesRequest, MailWorkspacePreview } from 'librechat-data-provider';
import { useMailImages } from '~/data-provider/Mail';
import { useLocalize } from '~/hooks';
import SafeMailPreview from './SafeMailPreview';

type Props = MailWorkspaceImagesRequest & {
  id: string;
  preview?: MailWorkspacePreview;
  text: string;
  title: string;
};

export default function MailImages(props: Props) {
  return <Images key={`${props.id}:${props.revision}:${props.kind}`} {...props} />;
}

function Images({ id, revision, kind, preview, text, title }: Props) {
  const t = useLocalize();
  const images = useMailImages(id, { kind, revision });
  const actionLabel = images.preview ? 'com_ui_mail_images_hide' : 'com_ui_mail_images_load';
  return (
    <div>
      {preview?.embeddedImagesAvailable === true && (
        <div className="mail-body-actions">
          <button
            className="mail-button"
            disabled={images.isLoading}
            onClick={images.preview ? images.hide : images.load}
          >
            {images.isLoading ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Image size={15} aria-hidden="true" />
            )}
            {t(images.isLoading ? 'com_ui_mail_images_loading' : actionLabel)}
          </button>
          <span className="mail-muted">{t('com_ui_mail_images_scope')}</span>
        </div>
      )}
      {images.isError && (
        <p className="mail-error" role="alert">
          {t('com_ui_mail_images_error')}
        </p>
      )}
      <SafeMailPreview preview={images.preview || preview} text={text} title={title} />
    </div>
  );
}
