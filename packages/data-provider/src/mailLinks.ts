const erpOrigin = 'https://erp.rzcloud.ch';
const safeLinksHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.safelinks\.protection\.outlook\.com$/;
const odooRedirectHost = 'redirect-url.email';
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
const odooParameters = new Set(['link', 'apn', 'afl', 'ibi', 'ifl']);

export type MailPreviewLink = {
  href: string;
  destination: string;
  viaSafeLinks: boolean;
  viaOdooRedirect: boolean;
};

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

/** Validate administrator-owned exact HTTPS origins; wrapper services are never trusted targets. */
export function normalizeMailTrustedOrigins(origins: readonly string[]): string[] | undefined {
  if (!Array.isArray(origins) || origins.length > 32) return;
  const normalized = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== 'string') return;
    const url = parseHttps(origin);
    if (
      !url ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^https:\/\/[a-z0-9.-]+\/?$/i.test(origin) ||
      url.hostname.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        url.hostname,
      ) ||
      !/[a-z]/.test(url.hostname.split('.').pop() || '') ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) ||
      safeLinksHost.test(url.hostname) ||
      url.hostname === odooRedirectHost
    )
      return;
    normalized.add(url.origin);
  }
  return Array.from(normalized);
}

function directTarget(value: string, origins: readonly string[]): boolean {
  const url = parseHttps(value);
  if (!url || !origins.includes(url.origin)) return false;
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

function wrapperParameters(url: URL): Set<string> | undefined {
  const names = new Set<string>();
  for (const parameter of url.search.slice(1).split('&')) {
    const rawName = parameter.split('=')[0];
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(rawName)) return;
    const normalized = rawName.toLowerCase();
    if (names.has(normalized) || (normalized === 'url' && rawName !== 'url')) return;
    names.add(normalized);
  }
  return names;
}

function odooDestination(value: string, origins: readonly string[]): string | undefined {
  const url = parseHttps(value);
  if (!url || url.hostname !== odooRedirectHost || url.pathname !== '/' || url.hash) return;
  const names = wrapperParameters(url);
  if (
    !names ||
    names.size !== odooParameters.size ||
    Array.from(url.searchParams.keys()).some((name) => !odooParameters.has(name)) ||
    url.searchParams.get('apn') !== 'com.odoo.mobile' ||
    url.searchParams.get('ibi') !== 'com.odoo.mobile'
  )
    return;
  const target = url.searchParams.get('link');
  if (
    !target ||
    target !== url.searchParams.get('afl') ||
    target !== url.searchParams.get('ifl') ||
    !directTarget(target, origins)
  )
    return;
  return target;
}

/** Inspect only the known wrapper shapes; never fetch targets or manufacture Microsoft scan URLs. */
export function mailPreviewLink(
  value: string,
  trustedOrigins: readonly string[] = [erpOrigin],
): MailPreviewLink | undefined {
  const origins = normalizeMailTrustedOrigins(trustedOrigins);
  if (!origins?.length) return;
  if (directTarget(value, origins))
    return { href: value, destination: value, viaSafeLinks: false, viaOdooRedirect: false };
  const odooTarget = odooDestination(value, origins);
  if (odooTarget)
    return { href: value, destination: odooTarget, viaSafeLinks: false, viaOdooRedirect: true };
  const url = parseHttps(value);
  if (!url || !safeLinksHost.test(url.hostname) || url.pathname !== '/' || url.hash) return;
  if (!wrapperParameters(url)) return;
  const wrappedTarget = url.searchParams.get('url');
  if (!wrappedTarget) return;
  const destination = directTarget(wrappedTarget, origins)
    ? wrappedTarget
    : odooDestination(wrappedTarget, origins);
  if (!destination) return;
  return {
    href: value,
    destination,
    viaSafeLinks: true,
    viaOdooRedirect: destination !== wrappedTarget,
  };
}
