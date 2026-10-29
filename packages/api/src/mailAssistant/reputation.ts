/**
 * HaGeZi Threat Intelligence Feeds (medium), downloaded as separate GPL-3.0 data at runtime.
 * No feed data or upstream code is bundled. Mail URLs stay local and are never submitted.
 * TLS protects transport; source dates/counts detect stale or truncated data, not forged signatures.
 */
export const MAIL_REPUTATION_FEED =
  'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.medium-onlydomains.txt';
export const MAIL_REPUTATION_SOURCE = 'https://github.com/hagezi/dns-blocklists';
export const MAIL_REPUTATION_LICENSE = 'https://github.com/hagezi/dns-blocklists/blob/main/LICENSE';
export const MAIL_REPUTATION_MAX_AGE = 48 * 60 * 60 * 1000;
const maxFeedBytes = 32 * 1024 * 1024;
const refreshTimeout = 30_000;
const minDomains = 1000;
const maxDomains = 1_000_000;
const maxClockSkew = 5 * 60 * 1000;
const domainPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type MailReputationVerdict = 'known_threat' | 'not_listed' | 'unavailable' | 'disabled';
export type MailReputationStatus = {
  enabled: boolean;
  ready: boolean;
  domainCount: number;
  refreshedAt?: number;
  sourceUpdatedAt?: number;
  reason?: 'not_initialized' | 'refresh_failed' | 'stale';
};
export type MailReputationFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type MailReputationOptions = {
  enabled: boolean;
  fetch?: MailReputationFetch;
  now?: () => number;
};
export type MailReputationSnapshot = {
  schema: 1;
  source: typeof MAIL_REPUTATION_FEED;
  content: string;
  refreshedAt: number;
};
type Snapshot = {
  domains: Set<string>;
  content: string;
  refreshedAt: number;
  sourceUpdatedAt: number;
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('reputation_unavailable'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('reputation_unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('reputation_unavailable'));
      },
    );
  });
}

async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const length = response.headers.get('content-length');
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (
    !response.ok ||
    response.redirected ||
    !response.body ||
    (contentType !== 'text/plain' && contentType !== 'application/octet-stream') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
  )
    throw new Error('reputation_unavailable');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('reputation_unavailable');
      chunks.push(Buffer.from(chunk.value));
    }
    if (!bytes) throw new Error('reputation_unavailable');
    return Buffer.concat(chunks, bytes);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function decodeFeed(content: string): { domains: Set<string>; sourceUpdatedAt: number } {
  if (Buffer.byteLength(content, 'utf8') > maxFeedBytes || content.includes('\r'))
    throw new Error('reputation_unavailable');
  let dateLine: string | undefined;
  let countLine: string | undefined;
  let headerLines = 0;
  let lineCount = 0;
  const domains = new Set<string>();
  let start = 0;
  while (start < content.length) {
    const end = content.indexOf('\n', start);
    const line = content.slice(start, end === -1 ? content.length : end);
    start = end === -1 ? content.length : end + 1;
    if (++lineCount > maxDomains + 64) throw new Error('reputation_unavailable');
    if (!line) continue;
    if (line.startsWith('#') && domains.size === 0) {
      if (++headerLines > 64 || line.length > 2048) throw new Error('reputation_unavailable');
      if (line.startsWith('# Last modified:')) {
        if (dateLine) throw new Error('reputation_unavailable');
        dateLine = line;
      }
      if (line.startsWith('# Number of entries:')) {
        if (countLine) throw new Error('reputation_unavailable');
        countLine = line;
      }
      continue;
    }
    if (
      !dateLine ||
      !countLine ||
      line.length > 253 ||
      !domainPattern.test(line) ||
      !/[a-z]/.test(line.split('.').pop() || '') ||
      domains.has(line)
    )
      throw new Error('reputation_unavailable');
    domains.add(line);
    if (domains.size > maxDomains) throw new Error('reputation_unavailable');
  }
  const date =
    /^# Last modified: (0[1-9]|[12][0-9]|3[01]) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20[0-9]{2}) ([01][0-9]|2[0-3]):([0-5][0-9]) UTC$/.exec(
      dateLine || '',
    );
  const count = /^# Number of entries: ([1-9][0-9]{0,6})$/.exec(countLine || '');
  if (!date || !count) throw new Error('reputation_unavailable');
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ].indexOf(date[2]);
  const sourceUpdatedAt = Date.UTC(
    Number(date[3]),
    month,
    Number(date[1]),
    Number(date[4]),
    Number(date[5]),
  );
  if (new Date(sourceUpdatedAt).getUTCDate() !== Number(date[1]))
    throw new Error('reputation_unavailable');
  const expectedCount = Number(count[1]);
  if (expectedCount < minDomains || expectedCount > maxDomains || domains.size !== expectedCount)
    throw new Error('reputation_unavailable');
  return { domains, sourceUpdatedAt };
}

/** Construction and lookups perform no I/O. The owner explicitly refreshes on startup and periodically. */
export function createMailLinkReputation(options: MailReputationOptions) {
  const fetchFeed = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let snapshot: Snapshot | undefined;
  let failed = false;
  let pending: Promise<MailReputationStatus> | undefined;

  function status(): MailReputationStatus {
    if (!options.enabled) return { enabled: false, ready: false, domainCount: 0 };
    const current = now();
    const fresh =
      snapshot &&
      current >= snapshot.refreshedAt - maxClockSkew &&
      current >= snapshot.sourceUpdatedAt - maxClockSkew &&
      current - snapshot.refreshedAt <= MAIL_REPUTATION_MAX_AGE &&
      current - snapshot.sourceUpdatedAt <= MAIL_REPUTATION_MAX_AGE;
    let reason: MailReputationStatus['reason'];
    if (!fresh) {
      reason = 'not_initialized';
      if (snapshot) reason = 'stale';
      else if (failed) reason = 'refresh_failed';
    }
    return {
      enabled: true,
      ready: Boolean(fresh),
      domainCount: snapshot?.domains.size ?? 0,
      ...(snapshot && {
        refreshedAt: snapshot.refreshedAt,
        sourceUpdatedAt: snapshot.sourceUpdatedAt,
      }),
      ...(reason && { reason }),
    };
  }

  function check(value: string): MailReputationVerdict {
    if (!options.enabled) return 'disabled';
    if (!status().ready || !snapshot) return 'unavailable';
    try {
      if (value.length > 16_384 || /[\s\\]/.test(value)) return 'unavailable';
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !domainPattern.test(url.hostname) ||
        !/[a-z]/.test(url.hostname.split('.').pop() || '')
      )
        return 'unavailable';
      // This upstream publishes wildcard-domain indicators, not URL-specific verdicts.
      const labels = url.hostname.split('.');
      while (labels.length > 1) {
        if (snapshot.domains.has(labels.join('.'))) return 'known_threat';
        labels.shift();
      }
      return 'not_listed';
    } catch {
      return 'unavailable';
    }
  }

  function validateFreshness(sourceUpdatedAt: number, refreshedAt: number) {
    const current = now();
    if (
      !Number.isSafeInteger(refreshedAt) ||
      sourceUpdatedAt > current + maxClockSkew ||
      refreshedAt > current + maxClockSkew ||
      current - refreshedAt > MAIL_REPUTATION_MAX_AGE ||
      current - sourceUpdatedAt > MAIL_REPUTATION_MAX_AGE ||
      sourceUpdatedAt > refreshedAt + maxClockSkew ||
      (snapshot && sourceUpdatedAt < snapshot.sourceUpdatedAt)
    )
      throw new Error('reputation_unavailable');
  }

  /** Persist only in application-owned storage; this is not an API for user-provided feeds. */
  function exportSnapshot(): MailReputationSnapshot | undefined {
    if (!snapshot || !options.enabled) return undefined;
    return {
      schema: 1,
      source: MAIL_REPUTATION_FEED,
      content: snapshot.content,
      refreshedAt: snapshot.refreshedAt,
    };
  }

  /** Restoring never changes the original fetch time or refreshes an expired dataset. */
  function restoreSnapshot(value: unknown): MailReputationStatus {
    if (!options.enabled) return status();
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('reputation_unavailable');
      const stored = value as Partial<MailReputationSnapshot>;
      if (
        stored.schema !== 1 ||
        stored.source !== MAIL_REPUTATION_FEED ||
        typeof stored.content !== 'string' ||
        typeof stored.refreshedAt !== 'number'
      )
        throw new Error('reputation_unavailable');
      const { domains, sourceUpdatedAt } = decodeFeed(stored.content);
      validateFreshness(sourceUpdatedAt, stored.refreshedAt);
      snapshot = {
        domains,
        sourceUpdatedAt,
        content: stored.content,
        refreshedAt: stored.refreshedAt,
      };
      failed = false;
    } catch {
      failed = true;
    }
    return status();
  }

  async function update(): Promise<MailReputationStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeout);
    const request: RequestInit = {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'text/plain', 'Accept-Encoding': 'identity' },
    };
    try {
      const feed = await abortable(fetchFeed(MAIL_REPUTATION_FEED, request), controller.signal);
      if (feed.url && feed.url !== MAIL_REPUTATION_FEED) throw new Error('reputation_unavailable');
      const bytes = await boundedBody(feed, maxFeedBytes, controller.signal);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const { domains, sourceUpdatedAt } = decodeFeed(content);
      const refreshedAt = now();
      validateFreshness(sourceUpdatedAt, refreshedAt);
      if (controller.signal.aborted) throw new Error('reputation_unavailable');
      snapshot = { domains, content, sourceUpdatedAt, refreshedAt };
      failed = false;
    } catch {
      failed = true;
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
    return status();
  }

  function refresh(): Promise<MailReputationStatus> {
    if (!options.enabled) return Promise.resolve(status());
    if (pending) return pending;
    pending = update().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return { refresh, check, status, exportSnapshot, restoreSnapshot };
}
