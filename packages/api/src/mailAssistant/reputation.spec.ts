import type { MailReputationFetch } from './reputation';
import {
  createMailLinkReputation,
  MAIL_REPUTATION_FEED,
  MAIL_REPUTATION_MAX_AGE,
} from './reputation';

const initialTime = Date.UTC(2026, 9, 29, 12);
const dateText = (time: number) => {
  const date = new Date(time);
  const months = [
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
  ];
  return `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
};
const data = (extra = '', modified = dateText(initialTime)) => {
  const entries =
    Array.from({ length: 1000 }, (_, index) => `phishing${index}.example`).join('\n') +
    '\n' +
    extra;
  const count = entries.split('\n').filter(Boolean).length;
  return Buffer.from(
    `# Synthetic test indicators only\n# Last modified: ${modified}\n# Number of entries: ${count}\n#\n${entries}`,
  );
};

function fixture(options: { enabled?: boolean; body?: Buffer } = {}) {
  let clock = initialTime;
  let body = options.body ?? data();
  const download: jest.MockedFunction<MailReputationFetch> = jest.fn(async (input) => {
    if (input !== MAIL_REPUTATION_FEED) throw new Error('Unexpected outbound request');
    return new Response(new Uint8Array(body), { headers: { 'content-type': 'text/plain' } });
  });
  const reputation = createMailLinkReputation({
    enabled: options.enabled ?? true,
    fetch: download,
    now: () => clock,
  });
  return {
    reputation,
    download,
    setTime: (time: number) => (clock = time),
    setBody: (value: Buffer) => (body = value),
  };
}

describe('local mail-link reputation feed', () => {
  test('performs no request until explicit startup and never requests a user target', async () => {
    const f = fixture();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.reputation.check('https://erp.rzcloud.ch/private?access_token=never-submit')).toBe(
      'unavailable',
    );
    expect(f.reputation.status()).toMatchObject({
      enabled: true,
      ready: false,
      reason: 'not_initialized',
    });
    expect(await f.reputation.refresh()).toMatchObject({ ready: true, domainCount: 1000 });
    expect(f.reputation.check('https://phishing1.example/path?token=never-submit')).toBe(
      'known_threat',
    );
    expect(f.reputation.check('https://sub.phishing1.example/path')).toBe('known_threat');
    expect(f.reputation.check('https://erp.rzcloud.ch/private?access_token=never-submit')).toBe(
      'not_listed',
    );
    expect(f.reputation.check('https://phishing1.example.evil.test/')).toBe('not_listed');
    expect(f.reputation.check('https://notphishing1.example/')).toBe('not_listed');
    expect(f.download.mock.calls.map(([url]) => url)).toEqual([MAIL_REPUTATION_FEED]);
    expect(f.download.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  });

  test('disabled reputation stays visibly disabled without network access', async () => {
    const f = fixture({ enabled: false });
    expect(await f.reputation.refresh()).toEqual({ enabled: false, ready: false, domainCount: 0 });
    expect(f.reputation.check('https://phishing1.example/')).toBe('disabled');
    expect(f.reputation.restoreSnapshot({})).toEqual({
      enabled: false,
      ready: false,
      domainCount: 0,
    });
    expect(f.reputation.exportSnapshot()).toBeUndefined();
    expect(f.download).not.toHaveBeenCalled();
  });

  test('deduplicates concurrent refresh requests', async () => {
    const f = fixture();
    const first = f.reputation.refresh();
    const second = f.reputation.refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(f.download).toHaveBeenCalledTimes(1);
    await f.reputation.refresh();
    expect(f.download).toHaveBeenCalledTimes(2);
  });

  test.each([
    '',
    'invalid',
    '31 Feb 2026 12:00 UTC',
    '29 Oct 2026 12:00 PST',
    dateText(initialTime - MAIL_REPUTATION_MAX_AGE - 60_000),
    dateText(initialTime + 600_000),
  ])('rejects unverifiable, old or future embedded source date: %s', async (modified) => {
    const f = fixture({ body: data('', modified) });
    expect(await f.reputation.refresh()).toMatchObject({ ready: false, reason: 'refresh_failed' });
    expect(f.reputation.check('https://erp.rzcloud.ch/')).toBe('unavailable');
  });

  test('requires unique date and count metadata before indicator data', async () => {
    for (const content of [
      data().toString().replace('# Last modified:', '# Missing:'),
      data().toString().replace('# Number of entries:', '# Missing:'),
      '# Last modified: 29 Oct 2026 12:00 UTC\n' + data(),
      '# Number of entries: 1000\n' + data(),
      data().toString().replace('# Number of entries: 1000', '# Number of entries: 999'),
      data().toString().replace('# Number of entries: 1000', '# Number of entries: 1001'),
      data().toString().replace('# Number of entries: 1000', '# Number of entries: 1000001'),
      data().toString().replace('# Number of entries: 1000', '# Number of entries: 01000'),
      data().toString() + '# Unexpected appended metadata\n',
    ]) {
      const f = fixture({ body: Buffer.from(content) });
      expect(await f.reputation.refresh()).toMatchObject({ ready: false, domainCount: 0 });
    }
  });

  test('expires the last valid snapshot and does not extend it after failed refresh', async () => {
    const f = fixture();
    await f.reputation.refresh();
    f.setTime(initialTime + 60_000);
    f.download.mockRejectedValue(new Error('private upstream credentials must not leak'));
    expect(await f.reputation.refresh()).toMatchObject({ ready: true, refreshedAt: initialTime });
    f.setTime(initialTime + MAIL_REPUTATION_MAX_AGE + 1);
    expect(await f.reputation.refresh()).toMatchObject({ ready: false, reason: 'stale' });
    expect(f.reputation.check('https://erp.rzcloud.ch/')).toBe('unavailable');
  });

  test('rejects source rollback while retaining the existing newer snapshot', async () => {
    const f = fixture();
    await f.reputation.refresh();
    f.setTime(initialTime + 60_000);
    f.setBody(data('new-phish.example\n', dateText(initialTime - 60_000)));
    expect(await f.reputation.refresh()).toMatchObject({
      ready: true,
      sourceUpdatedAt: initialTime,
      domainCount: 1000,
    });
    expect(f.reputation.check('https://new-phish.example/')).toBe('not_listed');
  });

  test('rejects stale source content even when its download has just completed', async () => {
    const f = fixture();
    await f.reputation.refresh();
    f.setTime(initialTime + MAIL_REPUTATION_MAX_AGE + 1);
    expect(await f.reputation.refresh()).toMatchObject({
      ready: false,
      reason: 'stale',
      refreshedAt: initialTime,
    });
  });

  test.each([
    Buffer.from('too-few.example\n'),
    data('https://not-a-domain.example/path\n'),
    data('0.0.0.0 mapped-host.example\n'),
    data('*.wildcard.example\n'),
    data('bad..example\n'),
    data('UPPERCASE.example\n'),
    data('127.0.0.1\n'),
    data('phishing1.example\n'),
    data('<script>alert(1)</script>\n'),
    data('phish.example\u0000\n'),
    Buffer.concat([data(), Buffer.from([0xc0, 0xaf])]),
  ])('rejects malformed/truncated indicators without a usable partial dataset %#', async (body) => {
    const f = fixture({ body });
    expect(await f.reputation.refresh()).toMatchObject({ ready: false, domainCount: 0 });
    expect(f.reputation.check('https://phishing1.example/')).toBe('unavailable');
  });

  test.each([
    'http://phishing1.example/',
    'javascript:alert(1)',
    'https://user@phishing1.example/',
    'https://phishing1.example:8443/',
    'https://phishing1.example/\n',
    'https://phishing1.example\\evil.test/',
    'https://127.0.0.1/',
  ])('rejects unsupported lookup input without fetching: %s', async (url) => {
    const f = fixture();
    await f.reputation.refresh();
    expect(f.reputation.check(url)).toBe('unavailable');
    expect(f.download).toHaveBeenCalledTimes(1);
  });

  test('rejects response redirects and HTML despite successful HTTP status', async () => {
    const redirected = new Response(new Uint8Array(data()), {
      headers: { 'content-type': 'text/plain' },
    });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const unexpectedUrl = new Response(new Uint8Array(data()), {
      headers: { 'content-type': 'text/plain' },
    });
    Object.defineProperty(unexpectedUrl, 'url', { value: 'https://another.example/feed' });
    for (const response of [
      new Response('<html>rate limit</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('moved', { status: 302, headers: { location: 'https://elsewhere.example' } }),
      redirected,
      unexpectedUrl,
    ]) {
      const f = fixture();
      f.download.mockResolvedValue(response);
      expect(await f.reputation.refresh()).toMatchObject({ ready: false });
    }
  });

  test('bounds a declared oversized response before reading it', async () => {
    const f = fixture();
    f.download.mockResolvedValue(
      new Response('oversized', {
        headers: { 'content-type': 'text/plain', 'content-length': '33554433' },
      }),
    );
    expect(await f.reputation.refresh()).toMatchObject({ ready: false });
  });

  test('bounds actual streamed bytes when Content-Length is missing', async () => {
    const f = fixture();
    f.setBody(Buffer.alloc(32 * 1024 * 1024 + 1, 65));
    expect(await f.reputation.refresh()).toMatchObject({ ready: false, domainCount: 0 });
  });

  test('times out a stalled upstream and allows the next explicit refresh', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.download.mockImplementation(() => new Promise(() => undefined));
      const pending = f.reputation.refresh();
      await jest.advanceTimersByTimeAsync(30_001);
      expect(await pending).toMatchObject({ ready: false, reason: 'refresh_failed' });
      expect(f.reputation.check('https://erp.rzcloud.ch/')).toBe('unavailable');
      expect(f.download.mock.calls[0][1]?.signal?.aborted).toBe(true);
      f.download.mockResolvedValue(
        new Response(new Uint8Array(data()), { headers: { 'content-type': 'text/plain' } }),
      );
      expect(await f.reputation.refresh()).toMatchObject({ ready: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('round-trips a trusted persisted snapshot without I/O or renewed freshness', async () => {
    const f = fixture();
    expect(f.reputation.exportSnapshot()).toBeUndefined();
    await f.reputation.refresh();
    const stored = f.reputation.exportSnapshot();
    const restored = fixture();
    restored.setTime(initialTime + 60_000);
    expect(restored.reputation.restoreSnapshot(stored)).toMatchObject({
      ready: true,
      refreshedAt: initialTime,
      sourceUpdatedAt: initialTime,
      domainCount: 1000,
    });
    expect(restored.reputation.check('https://phishing1.example/')).toBe('known_threat');
    expect(restored.download).not.toHaveBeenCalled();
    restored.setTime(initialTime + MAIL_REPUTATION_MAX_AGE + 1);
    expect(restored.reputation.restoreSnapshot(stored)).toMatchObject({
      ready: false,
      reason: 'stale',
      refreshedAt: initialTime,
    });
  });

  test('rejects malformed, wrong-provider, future and expired persisted snapshots', async () => {
    const f = fixture();
    await f.reputation.refresh();
    const stored = f.reputation.exportSnapshot();
    for (const value of [
      null,
      [],
      {},
      { ...stored, schema: 2 },
      { ...stored, source: 'https://evil.test/' },
      { ...stored, content: 'modified' },
      { ...stored, refreshedAt: initialTime + 600_000 },
      { ...stored, refreshedAt: initialTime - MAIL_REPUTATION_MAX_AGE - 1 },
      { ...stored, refreshedAt: initialTime - 600_000 },
    ]) {
      const restored = fixture();
      expect(restored.reputation.restoreSnapshot(value)).toMatchObject({ ready: false });
      expect(restored.download).not.toHaveBeenCalled();
    }
  });
});
