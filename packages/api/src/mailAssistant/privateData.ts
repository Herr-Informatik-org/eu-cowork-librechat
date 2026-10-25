import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface MailCodec {
  seal(owner: string, purpose: string, value: unknown): string;
  open<T>(owner: string, purpose: string, blob: string): T;
}

/** Bind ciphertext to its account and purpose, including after database row substitution. */
export function createMailCodec(keyHex: string): MailCodec {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw new Error('Mail-Verschlüsselung ist nicht eingerichtet.');
  const key = Buffer.from(keyHex, 'hex');
  return {
    seal(owner: string, purpose: string, value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify(['mail-assistant-v1', owner, purpose])));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
    },
    open<T>(owner: string, purpose: string, blob: string): T {
      const [iv, tag, data, extra] = blob.split('.');
      if (!iv || !tag || !data || extra) throw new Error('Mail-Daten sind nicht lesbar.');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify(['mail-assistant-v1', owner, purpose])));
      cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString(
          'utf8',
        ),
      ) as T;
    },
  };
}
