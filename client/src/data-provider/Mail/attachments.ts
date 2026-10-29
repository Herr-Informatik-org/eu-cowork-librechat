import { useEffect, useRef, useState } from 'react';
import { dataService } from 'librechat-data-provider';
import type { MailAttachments } from 'librechat-data-provider';

const maxBytes = 20 * 1024 * 1024;
type Attachment = MailAttachments['attachments'][number];
const supported: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
};

export function isDownloadableMailAttachment(item: Attachment): boolean {
  const extension = item.name.split('.').pop()?.toLowerCase() || '';
  return (
    Object.prototype.hasOwnProperty.call(supported, extension) &&
    supported[extension] === item.contentType.toLowerCase() &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    item.size <= maxBytes
  );
}

export function mailAttachmentFilename(name: string): string {
  const cleaned = name
    .replace(
      // eslint-disable-next-line no-control-regex -- Exclude path separators, controls and direction overrides.
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\/:*?"<>|]/g,
      '_',
    )
    .replace(/^\.+|[ .]+$/g, '');
  const extension = cleaned.slice(cleaned.lastIndexOf('.'));
  return `${cleaned.slice(0, Math.min(cleaned.length - extension.length, 160)) || 'Anhang'}${extension}`;
}

class AttachmentDownloadError extends Error {
  constructor(readonly status: number) {
    super('Attachment download failed');
  }
}

/** Never hand a browser a partial, oversized or unscanned response. */
export async function readScannedMailAttachment(
  response: Response,
  expectedSize: number,
): Promise<{ blob: Blob; scannedAt: string }> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AttachmentDownloadError(response.status);
  }
  const scannedAt = response.headers.get('X-Mail-Attachment-Scanned-At') || '';
  const declared = response.headers.get('Content-Length');
  if (
    response.headers.get('X-Mail-Attachment-Scan') !== 'no_known_threats' ||
    !Number.isFinite(Date.parse(scannedAt)) ||
    response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/octet-stream' ||
    !response.headers.get('Content-Disposition')?.startsWith('attachment;') ||
    !response.body ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    expectedSize > maxBytes ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedSize))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new AttachmentDownloadError(502);
  }
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > expectedSize || received > maxBytes) throw new AttachmentDownloadError(413);
      parts.push(Uint8Array.from(part.value).buffer);
    }
    if (received !== expectedSize) throw new AttachmentDownloadError(502);
    return { blob: new Blob(parts, { type: 'application/octet-stream' }), scannedAt };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Bytes are never placed in query caches, model context or persistent browser storage. */
export function useMailAttachmentDownload(id: string, revision: string, item: Attachment) {
  const [isLoading, setLoading] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number>();
  const [scannedAt, setScannedAt] = useState<string>();
  const active = useRef(true);
  const controller = useRef<AbortController>();
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    active.current = true;
    const retained = downloads.current;
    return () => {
      active.current = false;
      controller.current?.abort();
      for (const [url, timer] of retained) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      retained.clear();
    };
  }, []);

  const download = async () => {
    if (controller.current || !active.current || !isDownloadableMailAttachment(item)) return;
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setErrorStatus(undefined);
    setScannedAt(undefined);
    const deadline = setTimeout(() => request.abort(), 95_000);
    try {
      const response = await dataService.downloadMailWorkspaceAttachment(
        id,
        item.id,
        revision,
        request.signal,
      );
      if (!active.current || request.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const checked = await readScannedMailAttachment(response, item.size);
      if (!active.current || request.signal.aborted) return;
      const url = URL.createObjectURL(checked.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = mailAttachmentFilename(item.name);
      link.hidden = true;
      document.body.appendChild(link);
      try {
        link.click();
        setScannedAt(checked.scannedAt);
      } finally {
        link.remove();
        downloads.current.set(
          url,
          setTimeout(() => {
            URL.revokeObjectURL(url);
            downloads.current.delete(url);
          }, 60_000),
        );
      }
    } catch (error) {
      if (active.current)
        setErrorStatus(error instanceof AttachmentDownloadError ? error.status : 0);
    } finally {
      clearTimeout(deadline);
      controller.current = undefined;
      if (active.current) setLoading(false);
    }
  };
  return { download, isLoading, errorStatus, scannedAt };
}
