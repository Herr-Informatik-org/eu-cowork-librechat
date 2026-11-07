import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { scanMailAttachment, MAX_SCANNED_ATTACHMENT_BYTES } from './scanner';

const current = Date.parse('2026-10-29T10:00:00Z');
const version = 'ClamAV 1.4.3/27958/Thu Oct 29 09:00:00 2026';
const clean = Buffer.from('stream: OK\0');
const servers: (() => Promise<void>)[] = [];

async function clamd(
  options: {
    version?: string;
    response?: Buffer | null;
    holdVersion?: boolean;
    earlyResult?: boolean;
  } = {},
) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const payloads: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    let command: string | undefined;
    const payload: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!command) {
        const separator = pending.indexOf(0);
        if (separator < 0) return;
        command = pending.subarray(0, separator).toString();
        commands.push(command);
        pending = pending.subarray(separator + 1);
        if (command === 'zVERSION') {
          if (!options.holdVersion) socket.end(`${options.version ?? version}\0`);
          return;
        }
      }
      if (command !== 'zINSTREAM') return;
      if (options.earlyResult) {
        socket.end(clean);
        return;
      }
      while (pending.length >= 4) {
        const length = pending.readUInt32BE();
        if (pending.length < 4 + length) return;
        payload.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
        if (length !== 0) continue;
        payloads.push(Buffer.concat(payload));
        if (options.response === null) return;
        const response = options.response ?? clean;
        socket.write(response.subarray(0, 3));
        socket.end(response.subarray(3));
        return;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  servers.push(stop);
  return {
    options: { host: '127.0.0.1', port: address.port, now: () => current },
    commands,
    payloads,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((stop) => stop()));
});

describe('complete local ClamAV attachment scans', () => {
  test('streams the exact complete bytes in bounded INSTREAM frames and returns dated evidence', async () => {
    const daemon = await clamd();
    const bytes = Buffer.alloc(150_001);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await expect(scanMailAttachment(bytes, daemon.options)).resolves.toEqual({
      verdict: 'no_known_threats',
      engine: 'ClamAV',
      scannedAt: '2026-10-29T10:00:00.000Z',
      signaturesAt: '2026-10-29T09:00:00.000Z',
    });
    expect(daemon.commands).toEqual(['zVERSION', 'zINSTREAM']);
    expect(daemon.payloads).toEqual([bytes]);
  });
  test('rejects a clean response before all bytes and final frame have been transmitted', async () => {
    const daemon = await clamd({ earlyResult: true });
    await expect(
      scanMailAttachment(Buffer.alloc(MAX_SCANNED_ATTACHMENT_BYTES), daemon.options),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });
  test.each([
    'stream: Eicar-Signature FOUND\0',
    'stream: Heuristics.Encrypted.PDF FOUND\0',
    'stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0',
  ])('blocks malicious, encrypted and incomplete scans: %s', async (reply) => {
    const daemon = await clamd({ response: Buffer.from(reply) });
    await expect(
      scanMailAttachment(Buffer.from('opaque bytes'), daemon.options),
    ).rejects.toMatchObject({ reason: 'found' });
  });
  test.each([
    'stream: OK',
    'stream: OK\n',
    'stream: OK\0stream: Bad FOUND\0',
    'stream: ok\0',
    'INSTREAM size limit exceeded. ERROR\0',
    'stream: Unexpected error ERROR\0',
    'x'.repeat(8193) + '\0',
  ])('rejects malformed, partial and failed scan replies', async (reply) => {
    const daemon = await clamd({ response: Buffer.from(reply) });
    await expect(
      scanMailAttachment(Buffer.from('opaque bytes'), daemon.options),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });
  test.each([
    'ClamAV 1.4.3/27958/Mon Oct 26 09:00:00 2026',
    'ClamAV 1.4.3/27958/Fri Oct 30 09:00:00 2026',
    'ClamAV 1.4.3',
    'unknown scanner',
    'ClamAV 1.4.3/27958/Thu Oct 29 09:00:00 2026\0other',
  ])('never submits the attachment when signature freshness cannot be confirmed', async (value) => {
    const daemon = await clamd({ version: value });
    await expect(scanMailAttachment(Buffer.from('opaque bytes'), daemon.options)).rejects.toThrow();
    expect(daemon.commands).toEqual(['zVERSION']);
    expect(daemon.payloads).toEqual([]);
  });
  test('size limits reject bytes before any scanner connection', async () => {
    const daemon = await clamd();
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_SCANNED_ATTACHMENT_BYTES + 1)])
      await expect(scanMailAttachment(bytes, daemon.options)).rejects.toMatchObject({
        reason: 'size',
      });
    expect(daemon.commands).toEqual([]);
  });
  test.each([{ response: null }, { holdVersion: true }])(
    'timeouts release the slot and never become a clean verdict',
    async (options) => {
      const daemon = await clamd(options);
      await expect(
        scanMailAttachment(Buffer.from('opaque bytes'), { ...daemon.options, timeoutMs: 75 }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      const healthy = await clamd();
      await expect(
        scanMailAttachment(Buffer.from('opaque bytes'), healthy.options),
      ).resolves.toHaveProperty('verdict', 'no_known_threats');
    },
  );
  test('third concurrent scan is rejected without connecting or buffering another payload', async () => {
    const daemon = await clamd({ response: null });
    const options = { ...daemon.options, timeoutMs: 100 };
    const scans = [
      scanMailAttachment(Buffer.from('one'), options),
      scanMailAttachment(Buffer.from('two'), options),
    ];
    const pending = Promise.allSettled(scans);
    await expect(scanMailAttachment(Buffer.from('three'), options)).rejects.toMatchObject({
      reason: 'busy',
    });
    const results = await pending;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(daemon.commands.filter((command) => command === 'zINSTREAM')).toHaveLength(2);
  });
  test.each([
    { host: 'https://attacker.invalid/' },
    { host: 'attacker.invalid' },
    { host: '127.0.0.1', port: 0 },
    { host: '127.0.0.1', timeoutMs: 60_001 },
  ])('rejects invalid internal endpoint configuration', async (options) => {
    await expect(scanMailAttachment(Buffer.from('opaque bytes'), options)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
});
