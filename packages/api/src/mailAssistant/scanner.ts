import { createConnection } from 'node:net';
import { MailDraftError } from './errors';

export const MAX_SCANNED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const maxConcurrentScans = 2;
let activeScans = 0;

export interface MailScanOptions {
  /** Operator-configured internal clamd endpoint; never taken from mailbox content. */
  host: string;
  port?: number;
  timeoutMs?: number;
  now?: () => number;
}
export interface MailAttachmentScanResult {
  verdict: 'no_known_threats';
  engine: 'ClamAV';
  scannedAt: string;
  signaturesAt: string;
}

export class MailAttachmentScanError extends MailDraftError {
  constructor(public readonly reason: 'unavailable' | 'found' | 'size' | 'busy' | 'stale') {
    super(
      {
        unavailable: 'Die Anhangprüfung ist momentan nicht verfügbar. Der Anhang bleibt gesperrt.',
        found:
          'Die Anhangprüfung hat einen verdächtigen Inhalt erkannt. Der Anhang bleibt gesperrt.',
        size: 'Dieser Anhang überschreitet die Prüfgrenze von 20 MB und bleibt gesperrt.',
        busy: 'Die Anhangprüfung ist ausgelastet. Bitte versuche es später erneut.',
        stale:
          'Die Virensignaturen der Anhangprüfung sind nicht aktuell. Der Anhang bleibt gesperrt.',
      }[reason],
      { size: 413, found: 422, busy: 429, unavailable: 503, stale: 503 }[reason],
    );
  }
}

function command(options: MailScanOptions, input?: Buffer, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: options.host, port: options.port ?? 3310 });
    const received: Buffer[] = [];
    let size = 0;
    let settled = false;
    let sentComplete = !input;
    const finish = (error?: MailAttachmentScanError, response?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timeout = setTimeout(() => finish(new MailAttachmentScanError('unavailable')), timeoutMs);
    timeout.unref();
    socket.on('error', () => finish(new MailAttachmentScanError('unavailable')));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) return finish(new MailAttachmentScanError('unavailable'));
      received.push(chunk);
    });
    socket.on('end', () => {
      const response = Buffer.concat(received).toString('latin1');
      if (!sentComplete || !response.endsWith('\0') || response.slice(0, -1).includes('\0'))
        return finish(new MailAttachmentScanError('unavailable'));
      finish(undefined, response.slice(0, -1));
    });
    socket.on('close', () => finish(new MailAttachmentScanError('unavailable')));
    socket.on('connect', () => {
      const write = (chunk: Buffer) =>
        new Promise<void>((done, fail) =>
          socket.write(chunk, (error) => (error ? fail(error) : done())),
        );
      void (async () => {
        await write(Buffer.from(input ? 'zINSTREAM\0' : 'zVERSION\0'));
        if (!input) return;
        for (let offset = 0; offset < input.length; offset += 64 * 1024) {
          if (settled) return;
          const chunk = input.subarray(offset, Math.min(input.length, offset + 64 * 1024));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          await write(length);
          await write(chunk);
        }
        if (!settled) {
          await write(Buffer.alloc(4));
          sentComplete = true;
        }
      })().catch(() => finish(new MailAttachmentScanError('unavailable')));
    });
  });
}

/** Inspect the complete opaque buffer locally; only an exact clean verdict releases those bytes. */
export async function scanMailAttachment(
  bytes: Buffer,
  options: MailScanOptions = {
    host: process.env.MAIL_ASSISTANT_CLAMD_HOST ?? 'mail-attachment-scanner',
  },
): Promise<MailAttachmentScanResult> {
  if (!bytes.length || bytes.length > MAX_SCANNED_ATTACHMENT_BYTES)
    throw new MailAttachmentScanError('size');
  if (
    !options.host ||
    !/^(?:[a-z0-9][a-z0-9-]{0,62}|127\.0\.0\.1|::1)$/i.test(options.host) ||
    (options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) ||
    (options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 50 ||
        options.timeoutMs > 60_000))
  )
    throw new MailAttachmentScanError('unavailable');
  if (activeScans >= maxConcurrentScans) throw new MailAttachmentScanError('busy');
  activeScans += 1;
  const started = Date.now();
  const timeout = options.timeoutMs ?? 30_000;
  try {
    const version = await command(options, undefined, timeout);
    const match =
      /^ClamAV [0-9]+\.[0-9]+\.[0-9]+(?:[.-][a-zA-Z0-9]+)*\/[0-9]+\/([A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/.exec(
        version,
      );
    const databaseAt = match ? Date.parse(`${match[1]} UTC`) : NaN;
    const now = options.now?.() ?? Date.now();
    if (
      !Number.isFinite(databaseAt) ||
      databaseAt > now + 60 * 60_000 ||
      now - databaseAt > 48 * 60 * 60_000
    )
      throw new MailAttachmentScanError('stale');
    const remaining = timeout - (Date.now() - started);
    if (remaining <= 0) throw new MailAttachmentScanError('unavailable');
    const response = await command(options, bytes, remaining);
    if (response === 'stream: OK')
      return {
        verdict: 'no_known_threats',
        engine: 'ClamAV',
        scannedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        signaturesAt: new Date(databaseAt).toISOString(),
      };
    if (/^stream: [^\r\n]+ FOUND$/.test(response)) throw new MailAttachmentScanError('found');
    throw new MailAttachmentScanError('unavailable');
  } finally {
    activeScans -= 1;
  }
}
