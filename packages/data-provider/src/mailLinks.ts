const erpHost = 'erp.rzcloud.ch';
const safeLinksHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.safelinks\.protection\.outlook\.com$/;
const maxUrlLength = 16_384;
const unsafeCharacters =
  // eslint-disable-next-line no-control-regex -- Browsers normalize these characters before navigation.
  /[\s\u0000-\u001f\u007f-\u009f\\\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const encodedUnsafeCharacters =
  // eslint-disable-next-line no-control-regex -- Encoded controls must not cross the URL validation boundary.
  /[\u0000-\u001f\u007f-\u009f\\\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const redirectParameters = new Set([
  'redirect',
  'redirecturi',
  'redirecturl',
  'redirecthostname',
  'returnurl',
  'returnto',
  'next',
]);

export type MailPreviewLink = { href: string; viaSafeLinks: boolean };

function parseHttps(value: string): URL | undefined {
  if (
    !value ||
    value.length > maxUrlLength ||
    unsafeCharacters.test(value) ||
    /%(?![a-f0-9]{2})/i.test(value) ||
    !/^https:\/\/[a-z0-9.-]+(?:[/?#]|$)/i.test(value)
  )
    return;
  try {
    if (encodedUnsafeCharacters.test(decodeURIComponent(value))) return;
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url;
  } catch {
    /* Invalid or ambiguous URLs remain plain text. */
  }
}

function directErp(value: string): boolean {
  const url = parseHttps(value);
  if (!url || url.hostname !== erpHost) return false;
  let path = url.pathname;
  try {
    for (let depth = 0; depth < 3; depth++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch {
    return false;
  }
  if (
    path.includes('%') ||
    encodedUnsafeCharacters.test(path) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
    /^\/r(?:\/|$)/i.test(path) ||
    path.startsWith('//')
  )
    return false;
  for (const name of Array.from(url.searchParams.keys())) {
    if (redirectParameters.has(name.toLowerCase().replace(/[_-]/g, ''))) return false;
  }
  return true;
}

/** Allow one deployment-approved ERP origin, optionally through an existing Microsoft wrapper. */
export function mailPreviewLink(value: string): MailPreviewLink | undefined {
  if (directErp(value)) return { href: value, viaSafeLinks: false };
  const url = parseHttps(value);
  if (!url || !safeLinksHost.test(url.hostname) || url.pathname !== '/' || url.hash) return;
  const names = new Set<string>();
  for (const name of Array.from(url.searchParams.keys())) {
    const normalized = name.toLowerCase();
    if (names.has(normalized) || (normalized === 'url' && name !== 'url')) return;
    names.add(normalized);
  }
  const destination = url.searchParams.get('url');
  if (!destination || !directErp(destination)) return;
  return { href: value, viaSafeLinks: true };
}
