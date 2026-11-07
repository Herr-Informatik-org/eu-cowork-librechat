export const isHttpDownloadTarget = (target?: string | null): boolean =>
  /^https?:\/\//i.test(target ?? '');

/** Only the application-owned code download route may use the authenticated HTTP client. */
export function authenticatedCodeDownloadPath(
  target: string,
  basePath = '',
  origin = window.location.origin,
): string | undefined {
  try {
    const base = new URL(basePath || '/', origin);
    const url = new URL(target, origin);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (target !== url.pathname && target !== `${base.origin}${url.pathname}`)
    )
      return;
    const prefix = `${base.pathname.replace(/\/$/, '')}/api/files/code/download/`;
    if (!url.pathname.startsWith(prefix)) return;
    const identifiers = url.pathname.slice(prefix.length);
    if (/^[A-Za-z0-9_-]{21}\/[A-Za-z0-9_-]{21}$/.test(identifiers))
      return base.origin === origin ? url.pathname : url.href;
  } catch {
    return;
  }
}

export function triggerDownload(target: string, filename: string): void {
  const isBlob = target.startsWith('blob:');
  const link = document.createElement('a');
  link.href = target;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (isBlob) {
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  }
}
