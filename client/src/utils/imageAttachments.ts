import type { ExtendedFile } from '~/common';

type ImageAttachment = Partial<Pick<ExtendedFile, 'file_id' | 'type' | 'progress'>>;

/** A textless turn needs a stored image and must not consume pending uploads. */
export function hasReadyImageAttachments(files?: Iterable<ImageAttachment>): boolean {
  if (!files) return false;
  let hasImage = false;
  for (const file of files) {
    if (!file.file_id || (file.progress != null && file.progress < 1)) return false;
    if (file.type?.startsWith('image/')) hasImage = true;
  }
  return hasImage;
}
